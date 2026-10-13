import { randomUUID } from "node:crypto";
import {
  streamText,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from "ai";
import { neon } from "@neon/ai-sdk-provider";
import { z } from "zod";
import { compileBlueprint, type CompiledBlueprint } from "../shared/blueprint";
import { COLORS } from "../shared/catalogue";
import { MAX_AI_PARTS, type AIConversationRow } from "../shared/types";
import {
  ASSEMBLIES,
  DesignError,
  designCatalogue,
  designSchema,
  designGenerationSchema,
  designPatchSchema,
  applyDesignPatch,
  type Design,
} from "../shared/design";
import { bounds } from "../shared/geometry";
import { snapDesign, type DesignAdjustment } from "../shared/design-fit";
import { DomainError, lockAccess, type Identity } from "./auth";
import { pool, transaction } from "./db";
import { aiBuildErrorMessage } from "./ai-errors";
import { insertWorld, partFromRow } from "./worlds";
import { executeInTransaction } from "./commands";
import {
  aiWorkshopEdit,
  streamingPreview,
  workshopReference,
  sameAISnapshot,
  type AISnapshot,
} from "../shared/ai-workshop";
import type { PoolClient } from "pg";
import { rawSql } from "@neon/realtime/server";

const active = ["queued", "designing", "checking", "repairing"];
const running = ["designing", "checking", "repairing"];
const controllers = new Map<string, AbortController>();
const model = () => process.env.AI_MODEL || "gpt-5-4";
export const aiConfiguration = () => ({
  available: aiAvailable(),
  maxParts: MAX_AI_PARTS,
  model: model(),
  version: AI_BUILDER_VERSION,
});
export const AI_BUILDER_VERSION = "workshop-shared-chat-2";
export const aiAvailable = () =>
  !!(process.env.NEON_AI_GATEWAY_TOKEN && process.env.NEON_AI_GATEWAY_BASE_URL);
const publicColumns =
  "g.id::text,g.prompt,g.model,g.status,g.attempt,g.error,g.world::text,g.source::text,g.target::text,g.preview,g.activity,g.preview_version,g.blueprint,g.guest::text AS author,author.name AS author_name,author.color AS author_color,g.created_at::text,g.updated_at::text";
const conversationFrom =
  "ai_generations g JOIN guests author ON author.id=g.guest";
// Membership/session predicates stay in the live query, so withdrawal removes
// previously visible conversation rows without waiting for capability renewal.
const memberAccess = (world: string) =>
  `EXISTS(SELECT 1 FROM world_memberships m JOIN guest_sessions s ON s.guest=m.guest WHERE m.world=${world} AND m.guest=$2::uuid AND m.active=1 AND s.id=$3::uuid AND s.revoked=0)`;

async function generationAccess(
  c: PoolClient,
  a: Identity,
  id: string,
  editor = false,
) {
  const { rows } = await c.query(
    "SELECT guest,target FROM ai_generations WHERE id=$1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("Build not found", 404);
  if (row.target) await lockAccess(c, a, row.target, editor);
  else if (row.guest !== a.guest) throw new DomainError("Build not found", 404);
  return row;
}
export async function expireGenerations() {
  await pool.query(
    "UPDATE ai_generations SET status='failed',error='This build was interrupted. Please try again.',updated_at=clock_timestamp() WHERE status=ANY($1::text[]) AND lease_until<clock_timestamp()",
    [active],
  );
}
export async function getGeneration(a: Identity, id: string) {
  await expireGenerations();
  const row = await transaction(async (c) => {
    await generationAccess(c, a, id);
    const { rows } = await c.query(
      `SELECT ${publicColumns},(SELECT slug FROM worlds WHERE id=g.target) AS target_slug FROM ${conversationFrom} WHERE g.id=$1`,
      [id],
    );
    return rows[0];
  });
  const compiled =
    row.blueprint && ["ready", "accepted"].includes(row.status)
      ? compileBlueprint(row.blueprint)
      : null;
  if (compiled?.issues.length)
    throw new DomainError("This build no longer passes validation");
  return {
    ...row,
    parts: compiled?.parts || [],
    serverTime: Date.now(),
  };
}
export function generationQuery(a: Identity, id: string) {
  return rawSql<AIConversationRow>(
    `SELECT ${publicColumns} FROM ${conversationFrom} WHERE g.id=$1::uuid AND ((g.target IS NOT NULL AND ${memberAccess("g.target")}) OR (g.target IS NULL AND g.guest=$2::uuid AND EXISTS(SELECT 1 FROM guest_sessions s WHERE s.id=$3::uuid AND s.guest=g.guest AND s.revoked=0)))`,
    [id, a.guest, a.session],
  );
}
export function conversationQuery(a: Identity, world: string) {
  return rawSql<AIConversationRow>(
    `SELECT ${publicColumns} FROM ${conversationFrom} WHERE (g.target=$1::uuid OR (g.target IS NULL AND g.world=$1::uuid AND g.guest=$2::uuid)) AND ${memberAccess("$1::uuid")} ORDER BY g.created_at DESC,g.id DESC LIMIT 50`,
    [world, a.guest, a.session],
  );
}
export async function createGeneration(
  a: Identity,
  input: {
    id: string;
    prompt: string;
    source?: string;
    target?: string;
    newWorld?: boolean;
  },
) {
  if (!aiAvailable())
    throw new DomainError("AI building is not configured yet", 503);
  await expireGenerations();
  await transaction(async (c) => {
    // This lock only serializes AI concurrency admission, never workshop edits.
    await c.query("SELECT pg_advisory_xact_lock(729411)");
    const existing = await c.query(
      "SELECT guest,prompt,source::text,target::text FROM ai_generations WHERE id=$1",
      [input.id],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].guest !== a.guest ||
        existing.rows[0].prompt !== input.prompt ||
        existing.rows[0].source !== (input.source || null) ||
        (input.target && existing.rows[0].target !== input.target)
      )
        throw new DomainError("Build request already used");
      return;
    }
    const { rows } = await c.query(
      "SELECT count(*)::int AS active,count(*) FILTER(WHERE guest=$1)::int AS personal_active FROM ai_generations WHERE status=ANY($2::text[])",
      [a.guest, active],
    );
    const limits = rows[0];
    if (limits.personal_active)
      throw new DomainError("You already have a build in progress", 429);
    if (limits.active >= 2)
      throw new DomainError(
        "AI builders are busy. Please try again shortly.",
        429,
      );
    let reference: unknown = null;
    let target = input.target || null;
    let snapshot: AISnapshot | null = null;
    if (input.newWorld) {
      const world = await insertWorld(c, "Building with AI", a.guest);
      target = world.id;
      await c.query(
        "INSERT INTO world_memberships(world,guest) VALUES($1,$2)",
        [target, a.guest],
      );
      await c.query(
        "INSERT INTO guest_world_history(world,guest,generation) VALUES($1,$2,1)",
        [target, a.guest],
      );
    }
    // Read-lock the source before taking workshop locks, matching application’s
    // generation-first lock order and preventing cross-editor apply deadlocks.
    const prior = input.source
      ? await c.query(
          "SELECT blueprint,design,target::text,snapshot,status FROM ai_generations WHERE id=$1 AND ((target=$3::uuid AND $3::uuid IS NOT NULL) OR (target IS NULL AND guest=$2)) AND status IN ('ready','accepted') FOR SHARE",
          [input.source, a.guest, target],
        )
      : null;
    if (target) {
      await lockAccess(c, a, target);
      const pending = await c.query(
        "SELECT id FROM ai_generations WHERE target=$1 AND status=ANY($2::text[])",
        [target, active],
      );
      if (pending.rowCount)
        throw new DomainError(
          "This workshop already has an AI build in progress",
          409,
        );
      snapshot = await workshopSnapshot(c, target);
      if (snapshot.parts.length > MAX_AI_PARTS)
        throw new DomainError(
          `AI editing supports models of up to ${MAX_AI_PARTS} pieces`,
        );
      reference = workshopReference(snapshot);
    }
    if (input.source) {
      const source = prior?.rows[0];
      if (!source) throw new DomainError("Reference model not found", 404);
      if (!target || (source.target === target && source.status === "ready")) {
        reference = source.design || source.blueprint;
        if (target) snapshot = source.snapshot;
      } else if (source.target !== target)
        throw new DomainError("That draft belongs to another workshop", 409);
    }
    await c.query(
      "INSERT INTO ai_generations(id,guest,prompt,model,source,reference,target,snapshot,lease_until) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,clock_timestamp()+interval '3 minutes')",
      [
        input.id,
        a.guest,
        input.prompt,
        model(),
        input.source || null,
        reference ? JSON.stringify(reference) : null,
        target,
        snapshot ? JSON.stringify(snapshot) : null,
      ],
    );
  });
  return getGeneration(a, input.id);
}

async function workshopSnapshot(
  c: PoolClient,
  world: string,
): Promise<AISnapshot> {
  // Both collections share one SQL statement snapshot, including concurrent edits.
  const { rows } = await c.query(
    "SELECT title,generation,(SELECT coalesce(jsonb_agg(p ORDER BY p.id),'[]'::jsonb) FROM part_instances p WHERE p.world=w.id AND p.deleted=0) AS parts,(SELECT coalesce(jsonb_agg(e ORDER BY e.id),'[]'::jsonb) FROM part_connections e WHERE e.world=w.id AND e.deleted=0) AS connections FROM worlds w WHERE id=$1",
    [world],
  );
  const row = rows[0];
  return {
    generation: row.generation,
    title: row.title,
    parts: row.parts.map(partFromRow),
    connections: row.connections.map(({ id, a, b, ca, cb, revision }: any) => ({
      id,
      a,
      b,
      ca,
      cb,
      revision,
    })),
  };
}

export async function listGenerations(a: Identity, target: string) {
  await expireGenerations();
  const rows = await transaction(async (c) => {
    await lockAccess(c, a, target, false);
    return (
      await c.query(
        `SELECT ${publicColumns} FROM ${conversationFrom} WHERE g.target=$1 OR (g.target IS NULL AND g.world=$1 AND g.guest=$2) ORDER BY g.created_at DESC,g.id DESC LIMIT 50`,
        [target, a.guest],
      )
    ).rows;
  });
  return rows.reverse().map((row) => ({
    ...row,
    parts:
      row.blueprint && ["ready", "accepted"].includes(row.status)
        ? compileBlueprint(row.blueprint).parts
        : [],
  }));
}

export async function recordDrawing(
  id: string,
  preview: { parts: import("../shared/types").Part[]; title: string },
) {
  const result = await pool.query(
    "UPDATE ai_generations SET preview=$2::jsonb,preview_version=preview_version+1,activity=$3,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($4::text[]) RETURNING id",
    [
      id,
      JSON.stringify(preview),
      `Drawing ${preview.parts.length} pieces`,
      running,
    ],
  );
  return !!result.rowCount;
}

const system = `You are a skilled brick model designer. Build attractive, recognisable miniature models for Neonbricks.
Return a version 2 design: title, one-sentence summary, front, pieces. Declare front as +z/-z/+x/-x: the direction toward the main doorway, headlights, face, or other defining details. The compiler rotates the whole model to present that front to the viewer, so this MUST match the actual placements. Each piece has a short unique id, catalogue part, colour, turn, at=[x,y,z], and repeat=null or {count,step:[dx,dy,dz]}. A repeated row expands at at+i*step, keeping its orientation. Use repeat for courses, fence posts, stairs, windows, tree trunks and symmetry. Do not list identical repeated pieces individually. Maximum ${MAX_AI_PARTS} expanded pieces; aim for 40–140 where useful. Small requests can use fewer.
FIRST plan a coherent silhouette and palette. Choose a few defining features of the requested subject and build those prominently. Make roofs pitched, animal heads and tails readable, vehicle bodies supported, towers detailed. Use contrasting accent colours, a modest base or scenery where helpful, and a finished composition. Avoid random spare pieces or a mound of disconnected blocks. Most detail belongs on your declared front and sides; make it prominent from an isometric view. Doorways, arches and windows must be real openings: never place a solid wall immediately behind an opening. Do not describe details you did not build.
Units: x/z studs; y plate heights. One brick=3 plates. at is the minimum corner of the ROTATED bounding box. turn=0/1/2/3 is yaw only; odd turns swap width/depth. brick-1x4 turn=0 is 1 along x, 4 along z; turn=1 is 4 along x, 1 along z. Board x/z=-16..16, y=0..48. Build near centre; prefer integer coordinates. Keep the entire rotated shape inside these bounds.
Fit: parts may not overlap. Each part must connect to or rest on a supported part, with a path to the board. Studs are at cell centres; stack at the lower part's y+height, aligning integer x/z studs. Add roof plates over supporting walls, then slopes. Tiles/slopes have no studs above; do not float parts above them. Window frames are 3 wide, 1 deep, 6 high; leave a matching hole in the wall. Arches are 4 wide,1 deep,6 high with an open centre. Wall corners belong to only one wall. Chimneys need a real roof gap. A bridge can span a gap if connected at an end. A balcony needs an actual connection or support. Only yaw: horizontal pieces cannot be rotated vertically. Use stepped brick forms for vertical details.
Mechanical shortcuts are verified multi-piece assemblies, with the same placement/repeat fields. Prefer four-wheel-chassis for vehicles: its body platform top is at y=8, within x=1..5,z=2..6 relative to origin. Add a hood, supported cockpit, headlights and antenna; keep the antenna foot inside the roof footprint. Use wheel-axle for custom wheel fits, rather than guessing axle offsets. A wheel-axle has two tyres and two bearing mounts; a body may rest on bearing tops. Two turn=1 wheel-axles spaced along z make a four-wheel chassis. At turn=1 its size is 6 along x,3 along z; bearings top at y=6, in x=1..2 and 4..5,z=1..2 relative to assembly origin. Keep chassis x within 1..5 to clear tyres. A plate-2x4 at turn=1 is 4 along x and2 along z: at [originX+1,originY+6,originZ+0.5] makes a supported cross-deck. Keep the remainder of the body above that deck. All mechanics are static. Do not promise animation, motors or unsupported rotations.
Use upright-cross for windmill blades: a supported vertical cross in front of the tower, built from normal plates/bricks. Do NOT use a horizontal beam as a vertical blade, because only yaw is supported. Keep the mast grounded or on a base directly under its bottom at x=3,z=0 relative to origin.
Architectural shortcuts: prefer gable-roof for a pitched roof and pine-tree for a pine. Both expand to editable ordinary parts. The roof is ONLY 4 studs deep. Repeat along its ridge to cover a 4-stud-deep building; do not cover a deeper building with several parallel ridges. A slope descends from high at z=0 to low at z=depth for turn=0; two opposing slopes form a ridge only when their HIGH edges meet. Roof assemblies have a solid base: run a chimney alongside the wall outside the roof footprint, or build an actual gap using individual plates/slopes. Lay out wall courses around real door/window openings, and support a roof on the remaining wall edges. A 4-stud arch is exactly 6 plates tall, so its top aligns with two brick courses. Use enough pieces to make requested features readable rather than a tiny abstract approximation.
Assembly catalogue: ${JSON.stringify(Object.values(ASSEMBLIES).map(({ parts, ...a }) => a))}
Part catalogue size=[x studs,y plates,z studs] at turn=0: ${JSON.stringify(designCatalogue())}
Palette: ${COLORS.map((c) => `${c.name.toLowerCase()}=${c.hex}`).join(", ")}.
Example compact stack: {id:"floor",part:"plate-4x4",colour:"sand",turn:0,at:[-2,0,-2],repeat:null}, {id:"tower",part:"brick-2x2",colour:"jade",turn:0,at:[-1,1,-1],repeat:{count:3,step:[0,3,0]}}, {id:"cap",part:"slope-2x2",colour:"poppy",turn:0,at:[-1,10,-1],repeat:null}.
Validation feedback names expanded pieces as rowId_index or assemblyId_component. Fix the source row or assembly placement, preserving the subject. For an initial design return version 2; for a repair or user refinement return a patch as instructed.`;

export type GenerateCandidate = (
  prompt: string,
  repair: string,
  signal: AbortSignal,
  model: string,
  previous?: Design,
  draw?: (preview: {
    parts: import("../shared/types").Part[];
    title: string;
  }) => Promise<void>,
) => Promise<{ blueprint: unknown; inputTokens: number; outputTokens: number }>;
type CandidateAttempt = {
  blueprint: unknown;
  inputTokens: number;
  outputTokens: number;
  elapsedMs?: number;
  issues?: unknown;
  adjustments?: DesignAdjustment[];
};
export async function recordGenerationAttempt(
  id: string,
  attempt: number,
  stage: string,
  result?: CandidateAttempt,
) {
  const update = await pool.query(
    "UPDATE ai_generations SET status=$2,attempt=$3::int,blueprint=COALESCE($4::jsonb,blueprint),issues=$5::jsonb,input_tokens=input_tokens+$6,output_tokens=output_tokens+$7,attempts=CASE WHEN $4::jsonb IS NULL THEN attempts ELSE attempts||jsonb_build_object(($3::int)::text,$9::jsonb) END,activity=$10,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($8::text[]) RETURNING id",
    [
      id,
      stage,
      attempt,
      result ? JSON.stringify(result.blueprint) : null,
      result?.issues ? JSON.stringify(result.issues) : null,
      result?.inputTokens || 0,
      result?.outputTokens || 0,
      running,
      result ? JSON.stringify(result) : null,
      result && Array.isArray(result.issues) && result.issues.length
        ? `Found ${result.issues.length} fit ${result.issues.length === 1 ? "issue" : "issues"}; adjusting the design`
        : stage === "checking"
          ? "Checking collisions and connections"
          : attempt > 1
            ? `Adjusting the design · pass ${attempt}`
            : "Designing the model",
    ],
  );
  return !!update.rows[0];
}
export const generateCandidate: GenerateCandidate = async (
  prompt,
  repair,
  signal,
  modelId,
  previous,
  draw,
) => {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let streamError: unknown;
  try {
    const result = streamText({
      model: neon(modelId),
      output: previous
        ? Output.object({ schema: designPatchSchema, name: "design_patch" })
        : Output.object({
            schema: designGenerationSchema,
            name: "brick_design",
          }),
      system: previous
        ? `${system}\nPATCH MODE: Output only a patch: title and summary null to preserve them, changes=[{id,row}]. Supply a full replacement row to change/add it; row=null deletes it. Omitted rows stay exactly as they were. IDs in changes refer to original rows, not expanded components. For refinement, make the user's requested changes and preserve the rest. For repair, correct the errors without simplifying away requested features.`
        : system,
      prompt: `Build this: ${prompt}${repair}`,
      maxOutputTokens: 12000,
      maxRetries: 0,
      providerOptions: modelId.startsWith("gpt-")
        ? { openai: { reasoningEffort: "low" } }
        : undefined,
      abortSignal: signal,
      onError: ({ error }) => {
        streamError = error;
      },
      onFinish: ({ totalUsage }) => {
        usage = {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
        };
      },
    });
    let lastDraw = 0;
    let lastImage = "";
    for await (const partial of result.partialOutputStream) {
      signal.throwIfAborted();
      if (!draw || performance.now() - lastDraw < 800) continue;
      const image = streamingPreview(partial, previous);
      if (!image) continue;
      const signature = JSON.stringify(image);
      if (signature === lastImage) continue;
      lastDraw = performance.now();
      lastImage = signature;
      await draw(image);
    }
    const output = await result.output;
    const totalUsage = await result.totalUsage;
    return {
      blueprint: output,
      inputTokens: totalUsage.inputTokens || 0,
      outputTokens: totalUsage.outputTokens || 0,
    };
  } catch (error) {
    if (streamError) throw streamError;
    if (NoOutputGeneratedError.isInstance(error))
      return { blueprint: {}, ...usage };
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    let blueprint: unknown = {};
    try {
      blueprint = JSON.parse(error.text || "{}");
    } catch {}
    return {
      blueprint,
      inputTokens: error.usage?.inputTokens || 0,
      outputTokens: error.usage?.outputTokens || 0,
    };
  }
};

// Exported so the bounded repair behaviour can be tested without paid inference.
export async function buildCandidate(
  prompt: string,
  modelId: string,
  signal: AbortSignal,
  generate: GenerateCandidate,
  report: (
    attempt: number,
    stage: string,
    result?: CandidateAttempt,
  ) => Promise<void>,
  reference?: unknown,
): Promise<CompiledBlueprint & { design?: Design }> {
  let source =
    reference &&
    typeof reference === "object" &&
    "version" in reference &&
    reference.version === 2
      ? designSchema.parse(reference)
      : undefined;
  let repair = reference
    ? `\nRefine this reference model, applying the user's changes and preserving unaffected features: ${JSON.stringify(reference)}`
    : "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    await report(attempt, attempt === 1 ? "designing" : "repairing");
    const started = performance.now();
    const generated = await generate(prompt, repair, signal, modelId, source);
    const result = {
      ...generated,
      elapsedMs: Math.round(performance.now() - started),
      adjustments: [] as DesignAdjustment[],
    };
    signal.throwIfAborted();
    await report(attempt, "checking");
    let compiled: CompiledBlueprint;
    try {
      if (source) result.blueprint = applyDesignPatch(source, result.blueprint);
      if (
        result.blueprint &&
        typeof result.blueprint === "object" &&
        "version" in result.blueprint &&
        result.blueprint.version === 2
      )
        source = designSchema.parse(result.blueprint);
      compiled = compileBlueprint(result.blueprint);
      if (source && compiled.issues.length) {
        const fitted = snapDesign(source, compiled);
        source = fitted.design;
        compiled = fitted.compiled;
        result.blueprint = source;
        result.adjustments = fitted.adjustments;
      }
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof DesignError))
        throw error;
      const feedback =
        error instanceof z.ZodError
          ? JSON.stringify(
              error.issues
                .map((i) => ({ path: i.path, message: i.message }))
                .slice(0, 15),
            )
          : error.message;
      await report(attempt, "checking", {
        ...result,
        issues: [{ code: "schema", parts: [], message: feedback }],
      });
      repair = `\nYour previous design failed validation: ${feedback}.${source ? `\nPrevious design: ${JSON.stringify(source)}\nReturn a corrected patch.` : " Return a complete corrected version 2 design."}`;
      continue;
    }
    await report(attempt, "checking", {
      ...result,
      issues: compiled.issues,
    });
    if (!compiled.issues.length) return { ...compiled, design: source };
    const affected = new Set(compiled.issues.flatMap((i) => i.parts));
    const feedbackParts =
      source?.front && source.front !== "+z"
        ? compileBlueprint({ ...source, front: "+z" }).parts
        : compiled.parts;
    const extents = feedbackParts
      .filter((p) => affected.has(p.id))
      .map((p) => {
        const b = bounds(p);
        return {
          id: p.id,
          x: [b.minx / 6, b.maxx / 6],
          y: [b.miny / 2, b.maxy / 2],
          z: [b.minz / 6, b.maxz / 6],
        };
      });
    repair = `\nPrevious design: ${JSON.stringify(result.blueprint)}\nActual affected extents in studs/plates: ${JSON.stringify(extents)}\nValidation errors: ${JSON.stringify(compiled.issues)}\nFix the original rows that produced these pieces; check rotated dimensions, course heights and supporting surfaces. ${source ? "Return only a patch; keep unaffected rows." : "Return the complete corrected version 2 design."}`;
  }
  throw new DomainError(
    "I couldn't get all the pieces to fit. Try a simpler description or build again.",
  );
}

export async function runGeneration(a: Identity, id: string) {
  await getGeneration(a, id);
  const claimed = await transaction(async (c) => {
    await c.query("SELECT id FROM ai_generations WHERE id=$1 FOR UPDATE", [id]);
    await generationAccess(c, a, id, true);
    return c.query(
      "UPDATE ai_generations SET status='designing',lease_until=clock_timestamp()+interval '160 seconds',updated_at=clock_timestamp() WHERE id=$1 AND status='queued' RETURNING prompt,model,reference",
      [id],
    );
  });
  if (!claimed.rows[0]) return getGeneration(a, id);
  const controller = new AbortController();
  controllers.set(id, controller);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(150_000),
  ]);
  const timer = setInterval(() => {
    void pool
      .query("SELECT status FROM ai_generations WHERE id=$1", [id])
      .then((r) => {
        if (!running.includes(r.rows[0]?.status)) controller.abort();
      })
      .catch(() => controller.abort());
  }, 2000);
  try {
    const row = claimed.rows[0];
    const compiled = await buildCandidate(
      row.prompt,
      row.model,
      signal,
      (prompt, repair, signal, model, previous) =>
        generateCandidate(
          prompt,
          repair,
          signal,
          model,
          previous,
          async (preview) => {
            if (!(await recordDrawing(id, preview))) controller.abort();
            signal.throwIfAborted();
          },
        ),
      async (attempt, stage, result) => {
        if (!(await recordGenerationAttempt(id, attempt, stage, result)))
          controller.abort();
        signal.throwIfAborted();
      },
      row.reference,
    );
    signal.throwIfAborted();
    await pool.query(
      "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,design=$4::jsonb,preview=$5::jsonb,preview_version=preview_version+1,activity='Ready to apply',issues=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($3::text[])",
      [
        id,
        JSON.stringify(compiled.blueprint),
        running,
        compiled.design ? JSON.stringify(compiled.design) : null,
        JSON.stringify({
          parts: compiled.parts,
          title: compiled.blueprint.title,
        }),
      ],
    );
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = aiBuildErrorMessage(error, signal.aborted);
    console.error(
      "[ai-build]",
      id,
      error instanceof Error ? error.name : "Error",
      statusCode || "",
      (error as { code?: string }).code || "",
    );
    await pool.query(
      "UPDATE ai_generations SET status='failed',error=$2,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($3::text[])",
      [id, message, running],
    );
  } finally {
    clearInterval(timer);
    controllers.delete(id);
  }
  return getGeneration(a, id);
}

export async function cancelGeneration(a: Identity, id: string) {
  await getGeneration(a, id);
  await transaction(async (c) => {
    await c.query("SELECT id FROM ai_generations WHERE id=$1 FOR UPDATE", [id]);
    const row = await generationAccess(c, a, id, true);
    await c.query(
      "WITH RECURSIVE drafts AS (SELECT id,source,target FROM ai_generations WHERE id=$1 AND status='ready' UNION ALL SELECT g.id,g.source,g.target FROM ai_generations g JOIN drafts d ON g.id=d.source WHERE g.status='ready' AND g.target IS NOT DISTINCT FROM d.target AND (g.target IS NOT NULL OR g.guest=$2)) UPDATE ai_generations SET status='cancelled',updated_at=clock_timestamp() WHERE (target=$4::uuid OR (target IS NULL AND guest=$2)) AND (id=$1 OR id IN (SELECT id FROM drafts)) AND status=ANY($3::text[])",
      [id, a.guest, [...active, "ready"], row.target],
    );
  });
  controllers.get(id)?.abort();
  return getGeneration(a, id);
}

export async function acceptGeneration(a: Identity, id: string) {
  await transaction((c) => generationAccess(c, a, id, true));
  const candidate = await getGeneration(a, id);
  if (candidate.status !== "ready" && candidate.status !== "accepted")
    throw new DomainError("This build isn't ready to use");
  const compiled = compileBlueprint(candidate.blueprint);
  if (compiled.issues.length)
    throw new DomainError("This build no longer passes validation");
  return transaction(async (c) => {
    const session = await c.query(
      "SELECT id FROM guest_sessions WHERE id=$1 AND guest=$2 AND revoked=0 AND expires_at>clock_timestamp() AND absolute_expiry>clock_timestamp() FOR SHARE",
      [a.session, a.guest],
    );
    if (!session.rows[0]) throw new DomainError("Session expired", 401);
    const { rows } = await c.query(
      "SELECT status,world,blueprint,target,snapshot FROM ai_generations WHERE id=$1 FOR UPDATE",
      [id],
    );
    await generationAccess(c, a, id, true);
    const row = rows[0];
    if (row.status === "accepted") {
      const world = await c.query("SELECT slug FROM worlds WHERE id=$1", [
        row.world,
      ]);
      return world.rows[0];
    }
    if (
      row.status !== "ready" ||
      JSON.stringify(row.blueprint) !== JSON.stringify(candidate.blueprint)
    )
      throw new DomainError(
        "This build has changed. Please refresh the preview.",
      );
    if (row.target) {
      await lockAccess(c, a, row.target);
      const snapshot = row.snapshot as AISnapshot | null;
      if (!snapshot)
        throw new DomainError("This draft has no workshop snapshot");
      const current = await workshopSnapshot(c, row.target);
      if (!sameAISnapshot(current, snapshot))
        throw new DomainError(
          "The model changed while AI was building. Keep the current model and ask again.",
        );
      const edit = aiWorkshopEdit(snapshot, compiled.parts, id, randomUUID);
      if (edit.changes?.length) {
        const receipt = await executeInTransaction(c, a, row.target, edit);
        if (!receipt.accepted)
          throw new DomainError(
            receipt.error || "The workshop changed. Please ask again.",
          );
      }
      await c.query(
        "UPDATE ai_generations SET status='accepted',world=$2,activity='Applied to the workshop',updated_at=clock_timestamp() WHERE id=$1",
        [id, row.target],
      );
      // Title-only updates do not need an exclusive lock on an occupied workshop.
      if (!snapshot.parts.length)
        await c.query("UPDATE worlds SET title=$2 WHERE id=$1", [
          row.target,
          compiled.blueprint.title,
        ]);
      const world = await c.query("SELECT slug FROM worlds WHERE id=$1", [
        row.target,
      ]);
      return world.rows[0];
    }
    const world = await insertWorld(c, compiled.blueprint.title, a.guest);
    const ids = new Map(compiled.parts.map((p) => [p.id, randomUUID()]));
    const parts = compiled.parts.map((p) => ({
      id: ids.get(p.id),
      world: world.id,
      key: p.key,
      color: p.color,
      ...p.position,
      rotation: p.rotation,
      revision: 1,
      deleted: 0,
      ...bounds(p),
    }));
    await c.query(
      "INSERT INTO part_instances(id,world,key,color,x,y,z,rotation,revision,deleted,minx,miny,minz,maxx,maxy,maxz) SELECT id,world,key,color,x,y,z,rotation,revision,deleted,minx,miny,minz,maxx,maxy,maxz FROM jsonb_to_recordset($1::jsonb) AS p(id uuid,world uuid,key text,color text,x int,y int,z int,rotation int,revision int,deleted int,minx int,miny int,minz int,maxx int,maxy int,maxz int)",
      [JSON.stringify(parts)],
    );
    const edges = compiled.edges.map((e) => ({
      ...e,
      id: randomUUID(),
      world: world.id,
      a: ids.get(e.a),
      b: ids.get(e.b),
      revision: 1,
      deleted: 0,
    }));
    if (edges.length) {
      await c.query(
        "INSERT INTO part_connections(id,world,a,b,ca,cb,revision,deleted) SELECT id,world,a,b,ca,cb,revision,deleted FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,world uuid,a uuid,b uuid,ca text,cb text,revision int,deleted int)",
        [JSON.stringify(edges)],
      );
      const claims = edges.flatMap((e) => [
        ...(e.exclusiveA
          ? [{ world: world.id, part: e.a, slot: e.ca, connection: e.id }]
          : []),
        ...(e.exclusiveB
          ? [{ world: world.id, part: e.b, slot: e.cb, connection: e.id }]
          : []),
      ]);
      await c.query(
        "INSERT INTO connector_slot_claims(world,part,slot,connection) SELECT world,part,slot,connection FROM jsonb_to_recordset($1::jsonb) AS c(world uuid,part uuid,slot text,connection uuid)",
        [JSON.stringify(claims)],
      );
    }
    await c.query(
      "UPDATE ai_generations SET status='accepted',world=$2,updated_at=clock_timestamp() WHERE id=$1",
      [id, world.id],
    );
    return { slug: world.slug };
  });
}
