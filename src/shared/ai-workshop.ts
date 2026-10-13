import { COLORS } from "./catalogue";
import {
  CATALOGUE_VERSION,
  MAX_AI_PARTS,
  type Part,
  type Connection,
  type Edit,
} from "./types";
import { compileBlueprint } from "./blueprint";
import { validPart } from "./geometry";
import {
  designRowSchema,
  designSchema,
  applyDesignPatch,
  type Design,
} from "./design";

export type AISnapshot = {
  generation: number;
  title: string;
  parts: Part[];
  connections: Connection[];
};

export function sameAISnapshot(a: AISnapshot, b: AISnapshot) {
  const parts = (s: AISnapshot) =>
    s.parts
      .map((p) => [
        p.id,
        p.key,
        p.color,
        p.position.x,
        p.position.y,
        p.position.z,
        p.rotation,
        p.revision,
        !!p.deleted,
      ])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const edges = (s: AISnapshot) =>
    s.connections
      .map((e) => [e.id, e.a, e.b, e.ca, e.cb, e.revision])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return (
    a.generation === b.generation &&
    JSON.stringify(parts(a)) === JSON.stringify(parts(b)) &&
    JSON.stringify(edges(a)) === JSON.stringify(edges(b))
  );
}

export function workshopReference(snapshot: AISnapshot): unknown {
  if (!snapshot.parts.length) return null;
  const pieces = snapshot.parts.map((p, i) => ({
    id: `p${i}`,
    part: p.key,
    colour:
      COLORS.find(
        (c) => c.hex.toLowerCase() === p.color.toLowerCase(),
      )?.name.toLowerCase() || "sand",
    turn: p.rotation,
    at: [p.position.x / 6, p.position.y / 2, p.position.z / 6],
    repeat: null,
  }));
  if (pieces.length <= 100)
    return {
      version: 2,
      title: snapshot.title,
      summary: "The current workshop model.",
      front: "+z",
      pieces,
    };
  return {
    version: 1,
    catalogue: CATALOGUE_VERSION,
    title: snapshot.title,
    summary: "The current workshop model.",
    parts: pieces.map(({ repeat, ...p }) => ({ ...p, attach: null })),
  };
}

// An in-progress drawing is never a committed workshop. Only complete rows are
// drawn, and final acceptance still performs full validation.
export function streamingPreview(
  input: unknown,
  previous?: Design,
): { parts: Part[]; title: string } | null {
  if (!input || typeof input !== "object") return null;
  const partial = input as Record<string, unknown>;
  let design: unknown;
  if (previous) {
    if (!Array.isArray(partial.changes)) return null;
    const changes = partial.changes.filter((c) => {
      if (!c || typeof c !== "object") return false;
      const v = c as { id?: unknown; row?: unknown };
      return (
        typeof v.id === "string" &&
        (v.row === null || designRowSchema.safeParse(v.row).success)
      );
    });
    if (!changes.length) return null;
    try {
      design = applyDesignPatch(previous, {
        title: typeof partial.title === "string" ? partial.title : null,
        summary: typeof partial.summary === "string" ? partial.summary : null,
        changes,
      });
    } catch {
      return null;
    }
  } else {
    if (!Array.isArray(partial.pieces)) return null;
    const pieces = partial.pieces
      .map((row) => designRowSchema.safeParse(row))
      .filter((r) => r.success)
      .map((r) => r.data);
    if (!pieces.length || pieces.length > 100) return null;
    design = {
      version: 2,
      title:
        typeof partial.title === "string" && partial.title
          ? partial.title
          : "Building your model",
      summary: typeof partial.summary === "string" ? partial.summary : "",
      front: partial.front || "+z",
      pieces,
    };
  }
  try {
    const compiled = compileBlueprint(designSchema.parse(design));
    if (
      compiled.parts.some((p) => !validPart(p)) ||
      compiled.issues.some((i) => i.code === "duplicate_id")
    )
      return null;
    return { parts: compiled.parts, title: compiled.blueprint.title };
  } catch {
    return null;
  }
}

export function aiWorkshopEdit(
  snapshot: AISnapshot,
  parts: Part[],
  operationId: string,
  uuid: () => string,
): Edit {
  const before = new Map(snapshot.parts.map((p, i) => [`p${i}`, p]));
  const kept = new Set<string>();
  const changes: NonNullable<Edit["changes"]> = [];
  for (const p of parts) {
    const old = before.get(p.id);
    if (old) kept.add(old.id);
    if (
      !old ||
      old.key !== p.key ||
      old.color !== p.color ||
      old.rotation !== p.rotation ||
      old.position.x !== p.position.x ||
      old.position.y !== p.position.y ||
      old.position.z !== p.position.z
    )
      changes.push({
        id: old?.id || uuid(),
        ...(old ? { expected: old.revision } : {}),
        key: p.key,
        color: p.color,
        position: p.position,
        rotation: p.rotation,
      });
  }
  for (const old of snapshot.parts)
    if (!kept.has(old.id))
      changes.push({ id: old.id, expected: old.revision, deleted: true });
  if (parts.length > MAX_AI_PARTS || changes.length > MAX_AI_PARTS * 2)
    throw new Error("AI model is too large");
  const touched = new Set(changes.map((c) => c.id));
  return {
    operationId,
    generation: snapshot.generation,
    action: "edit",
    changes,
    connections: snapshot.connections
      .filter((c) => touched.has(c.a) || touched.has(c.b))
      .map(({ id, revision }) => ({ id, revision })),
  };
}
