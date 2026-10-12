import { z } from "zod";
import { CATALOGUE, COLORS } from "./catalogue";
import { bounds, connectorList, mask, mating, validPart } from "./geometry";
import { CATALOGUE_VERSION, MAX_AI_PARTS, type Part } from "./types";
import { expandDesign } from "./design";

export { MAX_AI_PARTS } from "./types";
export const blueprintSchema = z.object({
  version: z.literal(1),
  catalogue: z.literal(CATALOGUE_VERSION),
  title: z.string().min(1).max(64),
  summary: z.string().max(240),
  parts: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
        part: z.enum(CATALOGUE.map((p) => p.key) as [string, ...string[]]),
        colour: z.enum(
          COLORS.map((c) => c.name.toLowerCase()) as [string, ...string[]],
        ),
        turn: z.number().int().min(0).max(3),
        // A homogeneous array produces a portable JSON Schema. Native Gateway
        // structured output rejects tuple schemas with an array-valued `items`.
        at: z.array(z.number()).length(3).nullable(),
        attach: z
          .object({
            to: z.string().max(40),
            connector: z.string().max(40),
            ownConnector: z.string().max(40),
          })
          .nullable(),
      }),
    )
    .min(1)
    .max(MAX_AI_PARTS),
});
export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintIssue = { code: string; parts: string[]; message: string };
export type BlueprintEdge = {
  a: string;
  b: string;
  ca: string;
  cb: string;
  exclusiveA: boolean;
  exclusiveB: boolean;
};
export type CompiledBlueprint = {
  blueprint: Blueprint;
  parts: Part[];
  edges: BlueprintEdge[];
  issues: BlueprintIssue[];
};

// Both the preview and server use this compiler. Attachment coordinates come
// from the catalogue's actual connectors, rather than model arithmetic.
export function compileBlueprint(input: unknown): CompiledBlueprint {
  const blueprint = blueprintSchema.parse(
    input &&
      typeof input === "object" &&
      "version" in input &&
      input.version === 2
      ? expandDesign(input)
      : input,
  );
  const issues: BlueprintIssue[] = [];
  const issue = (code: string, parts: string[], message: string) => {
    if (issues.length < 30) issues.push({ code, parts, message });
  };
  const specs = new Map(blueprint.parts.map((p) => [p.id, p]));
  if (specs.size !== blueprint.parts.length)
    issue("duplicate_id", [], "Every part must have a unique local id.");
  const resolved = new Map<string, Part>();
  const visiting = new Set<string>();
  const resolve = (id: string): Part | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    const spec = specs.get(id);
    if (!spec) return undefined;
    if (visiting.has(id)) {
      issue("attachment_cycle", [id], "Attachments must not form a cycle.");
      return;
    }
    visiting.add(id);
    const p: Part = {
      id,
      key: spec.part,
      color: COLORS.find((c) => c.name.toLowerCase() === spec.colour)!.hex,
      position: { x: 0, y: 0, z: 0 },
      rotation: spec.turn,
      revision: 1,
    };
    if ((spec.at === null) === (spec.attach === null)) {
      issue(
        "placement",
        [id],
        "Provide exactly one of at or attach; set the other to null.",
      );
    } else if (spec.at) {
      const values = [spec.at[0] * 6, spec.at[1] * 2, spec.at[2] * 6];
      if (
        !values.every(
          (v) =>
            Number.isSafeInteger(Math.round(v)) &&
            Math.abs(v - Math.round(v)) < 1e-8,
        )
      )
        issue(
          "grid",
          [id],
          "Horizontal coordinates must be sixth-stud aligned; vertical coordinates must be half-plate aligned.",
        );
      p.position = {
        x: Math.round(values[0]),
        y: Math.round(values[1]),
        z: Math.round(values[2]),
      };
    } else if (spec.attach) {
      const target = resolve(spec.attach.to);
      const a =
        target &&
        connectorList(target).find((c) => c.id === spec.attach!.connector);
      const b = connectorList(p).find(
        (c) => c.id === spec.attach!.ownConnector,
      );
      if (!a || !b)
        issue(
          "connector",
          [id, spec.attach.to],
          "Attachment names an unknown part or connector.",
        );
      else {
        p.position = {
          x: a.at.x - b.at.x,
          y: a.at.y - b.at.y,
          z: a.at.z - b.at.z,
        };
        const moved = connectorList(p).find((c) => c.id === b.id)!;
        if (!mating(a, moved))
          issue(
            "connector_fit",
            [id, spec.attach.to],
            "Connectors do not mate with this turn. Check connector types and axes.",
          );
      }
    }
    visiting.delete(id);
    if (!validPart(p))
      issue(
        "bounds",
        [id],
        "Part is outside the 32 × 32 stud board or 48-plate height.",
      );
    resolved.set(id, p);
    return p;
  };
  blueprint.parts.forEach((p) => resolve(p.id));
  const parts = [...resolved.values()];
  if (issues.length) return { blueprint, parts, edges: [], issues };

  const occupied = new Map<string, string>();
  const clashes = new Set<string>();
  const cells = new Map(parts.map((p) => [p.id, mask(p)]));
  for (const p of parts)
    for (const cell of cells.get(p.id)!) {
      const k = `${cell.x},${cell.y},${cell.z}`,
        other = occupied.get(k);
      if (other) {
        const pair = [other, p.id].sort().join("/");
        if (!clashes.has(pair)) {
          clashes.add(pair);
          issue(
            "overlap",
            [other, p.id],
            "Parts overlap. Adjust the placement or attachment.",
          );
        }
      } else occupied.set(k, p.id);
    }

  const connectors = new Map<
    string,
    { part: Part; connector: ReturnType<typeof connectorList>[number] }[]
  >();
  const edges: BlueprintEdge[] = [],
    slots = new Map<string, string>();
  const graph = new Map(parts.map((p) => [p.id, new Set<string>()]));
  for (const p of parts)
    for (const connector of connectorList(p)) {
      const k = `${connector.axis}/${connector.at.x},${connector.at.y},${connector.at.z}`;
      const previous = connectors.get(k) || [];
      for (const other of previous)
        if (other.part.id !== p.id && mating(connector, other.connector)) {
          const edge = {
            a: other.part.id,
            b: p.id,
            ca: other.connector.id,
            cb: connector.id,
            exclusiveA: other.connector.exclusive,
            exclusiveB: connector.exclusive,
          };
          edges.push(edge);
          graph.get(edge.a)!.add(edge.b);
          graph.get(edge.b)!.add(edge.a);
          for (const [partId, c] of [
            [p.id, connector],
            [other.part.id, other.connector],
          ] as const)
            if (c.exclusive) {
              const slot = `${partId}/${c.id}`;
              // Colliding parts also create duplicate connector claims. Keep
              // repair feedback focused on the geometric cause in that case.
              if (slots.has(slot) && !clashes.size)
                issue(
                  "connector_taken",
                  [partId, p.id, other.part.id],
                  `Connector ${c.id} is claimed by multiple connections.`,
                );
              slots.set(slot, k);
            }
        }
      previous.push({ part: p, connector });
      connectors.set(k, previous);
    }
  const grounded = new Set(
    parts.filter((p) => bounds(p).miny === 0).map((p) => p.id),
  );
  // Mechanical mounts have no stud sockets. A part can also rest on a real
  // upward surface. These directed support edges are quality evidence only;
  // they never become invented connector records in the database.
  const supportedBy = new Map(parts.map((p) => [p.id, new Set<string>()]));
  for (const p of parts) {
    const contacts = new Map<string, number>();
    const bottom = bounds(p).miny;
    for (const cell of cells.get(p.id)!) {
      if (cell.y !== bottom) continue;
      const below = occupied.get(`${cell.x},${cell.y - 1},${cell.z}`);
      if (below && below !== p.id)
        contacts.set(below, (contacts.get(below) || 0) + 1);
    }
    for (const [lower, area] of contacts)
      if (area >= 9) supportedBy.get(lower)!.add(p.id);
  }
  const queue = [...grounded];
  for (let i = 0; i < queue.length; i++)
    for (const neighbour of [
      ...graph.get(queue[i])!,
      ...supportedBy.get(queue[i])!,
    ])
      if (!grounded.has(neighbour)) {
        grounded.add(neighbour);
        queue.push(neighbour);
      }
  for (const p of parts)
    if (!grounded.has(p.id))
      issue(
        "unattached",
        [p.id],
        "Part has no supported path to the board. Connect it, rest its bottom on a supported surface, or place it on the board.",
      );
  return { blueprint, parts, edges, issues };
}

export function catalogueForAI() {
  return CATALOGUE.map((d) => {
    const p: Part = {
      id: "example",
      key: d.key,
      color: COLORS[0].hex,
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      revision: 1,
    };
    return {
      part: d.key,
      size: [d.w, d.h, d.d],
      connectors: connectorList(p).map((c) => ({
        id: c.id,
        type: c.type,
        at: [c.at.x / 6, c.at.y / 2, c.at.z / 6],
        axis: c.axis,
      })),
    };
  });
}
