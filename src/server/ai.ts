import { randomUUID } from "node:crypto";
import {
  generateText,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from "ai";
import { neon } from "@neon/ai-sdk-provider";
import { z } from "zod";
import {
  blueprintSchema,
  catalogueForAI,
  compileBlueprint,
  type CompiledBlueprint,
} from "../shared/blueprint";
import { COLORS } from "../shared/catalogue";
import { CATALOGUE_VERSION } from "../shared/types";
import { bounds } from "../shared/geometry";
import { DomainError, type Identity } from "./auth";
import { pool, transaction } from "./db";
import { insertWorld } from "./worlds";
import { rawSql } from "@neon/realtime/server";

const active = ["queued", "designing", "checking", "repairing"];
const running = ["designing", "checking", "repairing"];
const controllers = new Map<string, AbortController>();
const model = () => process.env.AI_MODEL || "gpt-5-4";
export const aiAvailable = () =>
  !!(process.env.NEON_AI_GATEWAY_TOKEN && process.env.NEON_AI_GATEWAY_BASE_URL);
const publicColumns =
  "id::text,prompt,model,status,attempt,error,world::text,created_at::text,updated_at::text";
export async function expireGenerations() {
  await pool.query(
    "UPDATE ai_generations SET status='failed',error='This build was interrupted. Please try again.',updated_at=clock_timestamp() WHERE status=ANY($1::text[]) AND lease_until<clock_timestamp()",
    [active],
  );
}
export async function getGeneration(a: Identity, id: string) {
  await expireGenerations();
  const { rows } = await pool.query(
    `SELECT ${publicColumns},blueprint FROM ai_generations WHERE id=$1 AND guest=$2`,
    [id, a.guest],
  );
  if (!rows[0]) throw new DomainError("Build not found", 404);
  const row = rows[0];
  return {
    ...row,
    parts:
      row.blueprint && ["ready", "accepted"].includes(row.status)
        ? compileBlueprint(row.blueprint).parts
        : [],
    serverTime: Date.now(),
  };
}
export function generationQuery(a: Identity, id: string) {
  return rawSql<{
    id: string;
    status: string;
    attempt: number;
    error: string | null;
    world: string | null;
  }>(
    `SELECT g.id::text,g.status,g.attempt,g.error,g.world::text FROM ai_generations g WHERE g.id=$1::uuid AND g.guest=$2::uuid AND EXISTS(SELECT 1 FROM guest_sessions s WHERE s.id=$3::uuid AND s.guest=g.guest AND s.revoked=0)`,
    [id, a.guest, a.session],
  );
}
export async function createGeneration(
  a: Identity,
  input: { id: string; prompt: string },
) {
  if (!aiAvailable())
    throw new DomainError("AI building is not configured yet", 503);
  await expireGenerations();
  await transaction(async (c) => {
    // This lock only serializes AI budget reservations, never workshop edits.
    await c.query("SELECT pg_advisory_xact_lock(729411)");
    const existing = await c.query(
      "SELECT guest,prompt FROM ai_generations WHERE id=$1",
      [input.id],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].guest !== a.guest ||
        existing.rows[0].prompt !== input.prompt
      )
        throw new DomainError("Build request already used");
      return;
    }
    const { rows } = await c.query(
      "SELECT count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 day')::int AS daily,count(*) FILTER(WHERE guest=$1 AND created_at>clock_timestamp()-interval '1 hour')::int AS personal,count(*) FILTER(WHERE status=ANY($2::text[]))::int AS active,count(*) FILTER(WHERE guest=$1 AND status=ANY($2::text[]))::int AS personal_active FROM ai_generations WHERE created_at>clock_timestamp()-interval '1 day' OR status=ANY($2::text[])",
      [a.guest, active],
    );
    const limits = rows[0];
    const configuredLimit = Number(process.env.AI_DAILY_LIMIT || 40);
    const dailyLimit =
      Number.isSafeInteger(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : 40;
    if (limits.daily >= dailyLimit)
      throw new DomainError(
        "Today's AI building budget has been used. Please come back later.",
        429,
      );
    if (limits.personal >= 8)
      throw new DomainError(
        "You've made several AI builds recently. Please try again in an hour.",
        429,
      );
    if (limits.personal_active)
      throw new DomainError("You already have a build in progress", 429);
    if (limits.active >= 2)
      throw new DomainError(
        "AI builders are busy. Please try again shortly.",
        429,
      );
    await c.query(
      "INSERT INTO ai_generations(id,guest,prompt,model,lease_until) VALUES($1,$2,$3,$4,clock_timestamp()+interval '3 minutes')",
      [input.id, a.guest, input.prompt, model()],
    );
  });
  return getGeneration(a, input.id);
}

const system = `You design delightful, recognisable small brick models for Neonbricks.
Return the specified JSON blueprint, version 1, catalogue ${CATALOGUE_VERSION}.
Use 20–80 parts where helpful; maximum 100. Use only the supplied parts and colours.
Aim for a clear silhouette, coherent palette, interesting details and a model that looks good from an isometric camera. Make the requested subject, rather than merely describing it.
Coordinates at=[x,y,z]: x and z are studs, y is plate heights. A brick is 3 plates tall. Coordinates refer to the minimum corner of the ROTATED bounding box. turn=0,1,2,3 means quarter-turn yaw. Odd turns swap horizontal dimensions. CRITICAL: brick-1x4 at turn=0 occupies ONE stud along x and FOUR along z; turn=1 occupies FOUR along x and ONE along z. Every turn changes orientation around the minimum corner; it never moves that corner. Board x/z=-16..16, height y=0..48. Build near the centre. Prefer integer horizontal studs and integer plate heights.
Every part has exactly one placement: at coordinates with attach=null, OR at=null with attach={to:localPartId,connector:targetConnectorId,ownConnector:ownConnectorId}. The compiler solves the attachment translation at the specified turn. Attachments must be acyclic; connector names are from the catalogue. Studs mate sockets, shafts mate holes, hinge bases mate leaves, gears mate gears; axes and direction must match.
Parts must not overlap. Every part must have a connector path to a part on the board; separate grounded objects are fine. Bricks/plates stack by adding the lower part's plate height. Tiles and slopes have no top studs; do not stack bricks on them. Only yaw rotations are supported: a tile cannot be attached vertically to the side of a wall. Leave actual openings for windows and doors. Exclude corners already occupied by other walls. Lay a roof plate over supporting walls, then put slopes on the roof plate. Route chimneys through an actual gap in the roof. Mechanical components are static; use attachment placements for precise fits. Never claim motion or motors.
Colours: ${COLORS.map((c) => c.name.toLowerCase()).join(", ")}.
Keep summary to one short sentence describing the build. If given validation errors, correct the actual placements while preserving the user's subject.
Catalogue size=[width studs,height plates,depth studs]; connector coordinates are at turn=0:
${JSON.stringify(catalogueForAI())}
Example valid placements: a plate-4x4 at [-2,0,-2], a brick-2x2 at [-1,1,-1], and slope-2x2 at [-1,4,-1], all turn=0 and attach=null. Give each part a unique descriptive local id.`;

export type GenerateCandidate = (
  prompt: string,
  repair: string,
  signal: AbortSignal,
  model: string,
) => Promise<{ blueprint: unknown; inputTokens: number; outputTokens: number }>;
const generateCandidate: GenerateCandidate = async (
  prompt,
  repair,
  signal,
  modelId,
) => {
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const result = await generateText({
      model: neon(modelId),
      output: Output.object({
        schema: blueprintSchema,
        name: "brick_blueprint",
      }),
      system,
      prompt: `Build this: ${prompt}${repair}`,
      maxOutputTokens: 16000,
      maxRetries: 0,
      providerOptions: modelId.startsWith("gpt-")
        ? { openai: { reasoningEffort: "medium" } }
        : undefined,
      abortSignal: signal,
      onFinish: ({ totalUsage }) => {
        usage = {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
        };
      },
    });
    return {
      blueprint: result.output,
      inputTokens: result.totalUsage.inputTokens || 0,
      outputTokens: result.totalUsage.outputTokens || 0,
    };
  } catch (error) {
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
    result?: {
      blueprint: unknown;
      inputTokens: number;
      outputTokens: number;
      issues?: unknown;
    },
  ) => Promise<void>,
) {
  let repair = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    await report(attempt, attempt === 1 ? "designing" : "repairing");
    const result = await generate(prompt, repair, signal, modelId);
    signal.throwIfAborted();
    await report(attempt, "checking", result);
    let compiled: CompiledBlueprint;
    try {
      compiled = compileBlueprint(result.blueprint);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      repair = `\nYour previous candidate failed the blueprint schema: ${JSON.stringify(error.issues.map((i) => ({ path: i.path, message: i.message })).slice(0, 20))}. Return a complete corrected blueprint.`;
      continue;
    }
    if (!compiled.issues.length) return compiled;
    await report(attempt, "checking", {
      ...result,
      inputTokens: 0,
      outputTokens: 0,
      issues: compiled.issues,
    });
    const extents = compiled.parts.map((p) => {
      const b = bounds(p);
      return {
        id: p.id,
        x: [b.minx / 6, b.maxx / 6],
        y: [b.miny / 2, b.maxy / 2],
        z: [b.minz / 6, b.maxz / 6],
      };
    });
    repair = `\nPrevious blueprint: ${JSON.stringify(compiled.blueprint)}\nActual compiled extents in studs/plates: ${JSON.stringify(extents)}\nValidation errors: ${JSON.stringify(compiled.issues)}\nUse the extents to correct the overlapping axes; check rotations carefully. Return a complete corrected blueprint.`;
  }
  throw new DomainError(
    "I couldn't get all the pieces to fit. Try a simpler description or build again.",
  );
}

export async function runGeneration(a: Identity, id: string) {
  await getGeneration(a, id);
  const claimed = await pool.query(
    "UPDATE ai_generations SET status='designing',lease_until=clock_timestamp()+interval '160 seconds',updated_at=clock_timestamp() WHERE id=$1 AND guest=$2 AND status='queued' RETURNING prompt,model",
    [id, a.guest],
  );
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
      generateCandidate,
      async (attempt, stage, result) => {
        const update = await pool.query(
          "UPDATE ai_generations SET status=$2,attempt=$3,blueprint=COALESCE($4::jsonb,blueprint),issues=$5::jsonb,input_tokens=input_tokens+$6,output_tokens=output_tokens+$7,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($8::text[]) RETURNING id",
          [
            id,
            stage,
            attempt,
            result ? JSON.stringify(result.blueprint) : null,
            result?.issues ? JSON.stringify(result.issues) : null,
            result?.inputTokens || 0,
            result?.outputTokens || 0,
            running,
          ],
        );
        if (!update.rows[0]) controller.abort();
        signal.throwIfAborted();
      },
    );
    signal.throwIfAborted();
    await pool.query(
      "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,issues=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($3::text[])",
      [id, JSON.stringify(compiled.blueprint), running],
    );
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message =
      error instanceof DomainError
        ? error.message
        : signal.aborted
          ? "This build was interrupted. Please try again."
          : statusCode === 429
            ? "AI Gateway is busy or has reached its budget. Please try again later."
            : "AI couldn't finish this build. Please try again.";
    console.error(
      "[ai-build]",
      id,
      error instanceof Error ? error.name : "Error",
      statusCode || "",
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
  await pool.query(
    "UPDATE ai_generations SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND guest=$2 AND status=ANY($3::text[])",
    [id, a.guest, [...active, "ready"]],
  );
  controllers.get(id)?.abort();
  return getGeneration(a, id);
}

export async function acceptGeneration(a: Identity, id: string) {
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
      "SELECT status,world,blueprint FROM ai_generations WHERE id=$1 AND guest=$2 FOR UPDATE",
      [id, a.guest],
    );
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
