import { z } from "zod";
import { BY_KEY, CATALOGUE, COLORS } from "./catalogue";
import { CATALOGUE_VERSION, MAX_AI_PARTS } from "./types";
import type { Blueprint } from "./blueprint";

type Template = {
  name: string;
  size: number[];
  note: string;
  parts: {
    id: string;
    part: string;
    at: number[];
    colour?: string;
    turn?: number;
  }[];
};
export const ASSEMBLIES: Record<string, Template> = {
  "four-wheel-chassis": {
    name: "four-wheel-chassis",
    size: [6, 9, 8],
    note: "Complete fitted four-wheel chassis, axles along x at turn=0. A 4x4 studded body platform has min [1,7,2] and TOP y=8. Add body at y=8 within x=1..5,z=2..6. Tyres occupy x=0..1 and5..6, up to y=9. Place on the board; do not add another floor through this unit.",
    parts: [
      ...[0, 5].flatMap((z, i) => [
        {
          id: `wheelL${i}`,
          part: "wheel",
          at: [0, 0, z],
          turn: 1,
          colour: "graphite",
        },
        {
          id: `wheelR${i}`,
          part: "wheel",
          at: [5, 0, z],
          turn: 1,
          colour: "graphite",
        },
        {
          id: `axle${i}`,
          part: "axle-6",
          at: [0, 3, z + 1],
          turn: 1,
          colour: "sand",
        },
        {
          id: `mountL${i}`,
          part: "bearing",
          at: [1, 3, z + 1],
          turn: 1,
          colour: "graphite",
        },
        {
          id: `mountR${i}`,
          part: "bearing",
          at: [4, 3, z + 1],
          turn: 1,
          colour: "graphite",
        },
        {
          id: `deck${i}`,
          part: "plate-2x4",
          at: [1, 6, z + 1],
          turn: 1,
          colour: "graphite",
        },
      ]),
      { id: "bodyPlatform", part: "plate-4x4", at: [1, 7, 2] },
    ],
  },
  "upright-cross": {
    name: "upright-cross",
    size: [7, 29, 1],
    note: "Static vertical brick cross for windmill blades or a sign. Faces z at turn=0. 7 studs wide,29 plates high. A brown grounded mast supports four pale arms; place in front of a tower without overlapping it. The pole starts at [3,0,0]; a base underneath must reach that point. Not a spinning propeller.",
    parts: [
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `mast${i}`,
        part: "round",
        at: [3, i * 3, 0],
        colour: "tangerine",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `lower${i}`,
        part: "brick-1x1",
        at: [3, 6 + i * 3, 0],
      })),
      { id: "left", part: "plate-1x4", at: [0, 15, 0], turn: 1 },
      { id: "right", part: "plate-1x4", at: [3, 16, 0], turn: 1 },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `upper${i}`,
        part: "brick-1x1",
        at: [3, 17 + i * 3, 0],
      })),
    ],
  },
  "gable-roof": {
    name: "gable-roof",
    size: [4, 4, 4],
    note: "A plate and four slopes forming a proper pitched roof, ridge along x at turn=0. Place on wall tops. Repeat step=[4,0,0] for a wider roof. Chimneys belong outside its footprint; use individual pieces for a roof with a chimney gap.",
    parts: [
      { id: "base", part: "plate-4x4", at: [0, 0, 0] },
      { id: "back1", part: "slope-2x2", at: [0, 1, 0], turn: 2 },
      { id: "back2", part: "slope-2x2", at: [2, 1, 0], turn: 2 },
      { id: "front1", part: "slope-2x2", at: [0, 1, 2] },
      { id: "front2", part: "slope-2x2", at: [2, 1, 2] },
    ],
  },
  "pine-tree": {
    name: "pine-tree",
    size: [4, 14, 4],
    note: "A tapered evergreen: brown trunk and green layered branches, 4x4 footprint and 14 plates tall. Place on the ground or a base. Foliage uses the requested colour; trunk is tangerine.",
    parts: [
      { id: "trunk", part: "round", at: [1, 0, 1], colour: "tangerine" },
      { id: "trunk2", part: "round", at: [1, 3, 1], colour: "tangerine" },
      { id: "boughs", part: "plate-4x4", at: [0, 6, 0] },
      { id: "core", part: "brick-2x2", at: [1, 7, 1] },
      { id: "left", part: "slope-1x2", at: [0, 7, 1] },
      { id: "right", part: "slope-1x2", at: [3, 7, 1], turn: 2 },
      { id: "back", part: "slope-1x2", at: [1, 7, 0], turn: 1 },
      { id: "front", part: "slope-1x2", at: [1, 7, 3], turn: 3 },
      { id: "crown", part: "plate-2x2", at: [1, 10, 1] },
      { id: "tip", part: "slope-1x2", at: [1, 11, 1] },
    ],
  },
  "wheel-axle": {
    name: "wheel-axle",
    size: [3, 9, 6],
    note: "Two tyres on a 6-stud axle, with two bearings. turn=0 axle runs along z; turn=1 along x. At turn=0, bearings occupy x=1..2,z=1..2 and 4..5, top y=6. A deck can rest on them at y=6, within z=1..5. Wheels occupy z=0..1 and 5..6 and rise to y=9; keep the body out of those planes.",
    parts: [
      { id: "front", part: "wheel", at: [0, 0, 0], colour: "graphite" },
      { id: "rear", part: "wheel", at: [0, 0, 5], colour: "graphite" },
      { id: "shaft", part: "axle-6", at: [1, 3, 0], colour: "sand" },
      { id: "mount1", part: "bearing", at: [1, 3, 1] },
      { id: "mount2", part: "bearing", at: [1, 3, 4] },
    ],
  },
  "gear-pair": {
    name: "gear-pair",
    size: [14 / 3, 9, 1],
    note: "A fitted 12/20-tooth pair; axes along z at turn=0. Large gear rests on the board when placed at y=0. Keep this unit separate or provide a supported mounting assembly; it has no top studs.",
    parts: [
      { id: "small", part: "gear-12", at: [0, 1.5, 0] },
      { id: "large", part: "gear-20", at: [5 / 3, 0, 0] },
    ],
  },
  "hinge-pair": {
    name: "hinge-pair",
    size: [2, 1, 4],
    note: "Two fitted coplanar hinge leaves; sockets below and studs above. Static, not folded.",
    parts: [
      { id: "base", part: "hinge-a", at: [0, 0, 0] },
      { id: "leaf", part: "hinge-b", at: [0, 0, 2] },
    ],
  },
};
const vector = z.array(z.number()).length(3);
export const designRowSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/),
  part: z.enum([...CATALOGUE.map((p) => p.key), ...Object.keys(ASSEMBLIES)] as [
    string,
    ...string[],
  ]),
  colour: z.enum(
    COLORS.map((c) => c.name.toLowerCase()) as [string, ...string[]],
  ),
  turn: z.number().int().min(0).max(3),
  at: vector,
  repeat: z
    .object({ count: z.number().int().min(2).max(32), step: vector })
    .nullable(),
});
export const designSchema = z.object({
  version: z.literal(2),
  title: z.string().min(1).max(64),
  summary: z.string().max(240),
  front: z.enum(["+z", "-z", "+x", "-x"]).optional(),
  pieces: z.array(designRowSchema).min(1).max(100),
});
// Required for new inference; optional above for previously saved v2 drafts.
export const designGenerationSchema = designSchema.extend({
  front: z.enum(["+z", "-z", "+x", "-x"]),
});
export const presentationTurn = (front?: Design["front"]) =>
  ({ "+z": 0, "+x": 1, "-z": 2, "-x": 3 })[front || "+z"];
export type Design = z.infer<typeof designSchema>;
export class DesignError extends Error {}
export const designPatchSchema = z.object({
  title: z.string().min(1).max(64).nullable(),
  summary: z.string().max(240).nullable(),
  changes: z
    .array(
      z.object({ id: z.string().max(24), row: designRowSchema.nullable() }),
    )
    .min(1)
    .max(40),
});
export function applyDesignPatch(previous: Design, input: unknown): Design {
  const patch = designPatchSchema.parse(input);
  const rows = new Map(previous.pieces.map((p) => [p.id, p]));
  const changed = new Set<string>();
  for (const change of patch.changes) {
    if (changed.has(change.id))
      throw new DesignError(`Row ${change.id} patched twice.`);
    changed.add(change.id);
    if (change.row) {
      if (change.row.id !== change.id)
        throw new DesignError("Patch row id must match change id.");
      rows.set(change.id, change.row);
    } else if (!rows.delete(change.id))
      throw new DesignError(`Unknown row ${change.id}.`);
  }
  return designSchema.parse({
    ...previous,
    title: patch.title || previous.title,
    summary: patch.summary ?? previous.summary,
    pieces: [...rows.values()],
  });
}

export function expandDesign(input: unknown): Blueprint {
  const design = designSchema.parse(input);
  const parts: Blueprint["parts"] = [];
  const ids = new Set<string>();
  for (const spec of design.pieces) {
    if (ids.has(spec.id)) throw new DesignError(`Duplicate row id: ${spec.id}`);
    ids.add(spec.id);
    const assembly = ASSEMBLIES[spec.part];
    const count = spec.repeat?.count || 1;
    const templates = assembly?.parts || [
      { id: "", part: spec.part, at: [0, 0, 0] },
    ];
    if (parts.length + count * templates.length > MAX_AI_PARTS)
      throw new DesignError(
        `Expanded design exceeds ${MAX_AI_PARTS} pieces. Reduce repeat counts.`,
      );
    for (let i = 0; i < count; i++) {
      const origin = spec.at.map(
        (v, axis) => v + i * (spec.repeat?.step[axis] || 0),
      );
      for (const template of templates) {
        let [x, y, z] = template.at;
        if (assembly) {
          const d = BY_KEY[template.part];
          const w = template.turn && template.turn % 2 ? d.d : d.w;
          const depth = template.turn && template.turn % 2 ? d.w : d.d;
          if (spec.turn === 1) [x, z] = [assembly.size[2] - z - depth, x];
          else if (spec.turn === 2)
            [x, z] = [assembly.size[0] - x - w, assembly.size[2] - z - depth];
          else if (spec.turn === 3) [x, z] = [z, assembly.size[0] - x - w];
        }
        const id = `${spec.id}${spec.repeat ? `_${i}` : ""}${assembly ? `_${template.id}` : ""}`;
        parts.push({
          id,
          part: template.part,
          colour: template.colour || spec.colour,
          turn: (spec.turn + (template.turn || 0)) % 4,
          at: [origin[0] + x, origin[1] + y, origin[2] + z],
          attach: null,
        });
      }
    }
  }
  if (new Set(parts.map((p) => p.id)).size !== parts.length)
    throw new DesignError(
      "Expanded piece IDs collide. Give rows distinct names.",
    );
  // Present the declared front toward +z, matching the editor's default camera.
  const turn = presentationTurn(design.front);
  if (turn)
    for (const p of parts) {
      const d = BY_KEY[p.part];
      const w = p.turn % 2 ? d.d : d.w;
      const depth = p.turn % 2 ? d.w : d.d;
      const [x, y, z] = p.at!;
      p.at =
        turn === 1
          ? [-z - depth, y, x]
          : turn === 2
            ? [-x - w, y, -z - depth]
            : [z, y, -x - w];
      p.turn = (p.turn + turn) % 4;
    }
  return {
    version: 1,
    catalogue: CATALOGUE_VERSION,
    title: design.title,
    summary: design.summary,
    parts,
  };
}

export function designCatalogue() {
  return CATALOGUE.map((d) => ({
    part: d.key,
    size: [d.w, d.h, d.d],
    studs: d.studs,
    sockets: [
      "brick",
      "plate",
      "tile",
      "round",
      "slope",
      "wedge",
      "arch",
      "window",
      "hinge",
    ].includes(d.shape),
  }));
}
