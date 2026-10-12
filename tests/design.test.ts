import { describe, expect, it } from "vitest";
import {
  ASSEMBLIES,
  expandDesign,
  applyDesignPatch,
  type Design,
} from "../src/shared/design";
import { compileBlueprint, MAX_AI_PARTS } from "../src/shared/blueprint";
import { bounds, collision, mask } from "../src/shared/geometry";
const row = (
  id: string,
  part: string,
  at = [0, 0, 0],
  turn = 0,
): Design["pieces"][number] => ({
  id,
  part,
  colour: "jade",
  turn,
  at,
  repeat: null,
});
const design = (pieces: Design["pieces"]): Design => ({
  version: 2,
  title: "Model",
  summary: "A model.",
  pieces,
});
describe("compact AI designs", () => {
  it("applies bounded add/replace/delete patches without mutating the original", () => {
    const original = design([
      row("a", "brick-1x1"),
      row("b", "brick-1x1", [2, 0, 0]),
    ]);
    const patched = applyDesignPatch(original, {
      title: null,
      summary: null,
      changes: [
        { id: "a", row: null },
        { id: "b", row: row("b", "brick-1x1", [3, 0, 0]) },
        { id: "c", row: row("c", "brick-1x1", [5, 0, 0]) },
      ],
    });
    expect(patched.pieces.map((p) => p.id)).toEqual(["b", "c"]);
    expect(original.pieces[1].at).toEqual([2, 0, 0]);
    for (const changes of [
      [{ id: "missing", row: null }],
      [{ id: "a", row: row("b", "brick-1x1") }],
      [
        { id: "a", row: null },
        { id: "a", row: row("a", "brick-1x1") },
      ],
    ])
      expect(() =>
        applyDesignPatch(original, { title: null, summary: null, changes }),
      ).toThrow();
  });
  it("expands a course with stable IDs and normal editable parts", () => {
    const d = design([
      { ...row("tower", "brick-2x2"), repeat: { count: 4, step: [0, 3, 0] } },
    ]);
    const b = compileBlueprint(d);
    expect(b.issues).toEqual([]);
    expect(b.blueprint.version).toBe(1);
    expect(b.parts.map((p) => p.position.y)).toEqual([0, 6, 12, 18]);
    expect(b.parts.map((p) => p.id)).toEqual([
      "tower_0",
      "tower_1",
      "tower_2",
      "tower_3",
    ]);
    expect(b.edges.length).toBe(12);
  });
  it("keeps all verified assemblies fitted through four yaws", () => {
    for (const key of Object.keys(ASSEMBLIES))
      for (let turn = 0; turn < 4; turn++) {
        const b = compileBlueprint(
          design([row("mechanism", key, [-4, 0, -4], turn)]),
        );
        expect(b.issues, `${key}/${turn}`).toEqual([]);
        expect(b.edges.length).toBeGreaterThan(0);
        const size = ASSEMBLIES[key].size;
        expect(Math.min(...b.parts.map((p) => bounds(p).minx))).toBe(-24);
        expect(
          Math.max(...b.parts.map((p) => bounds(p).maxx)) - -24,
        ).toBeCloseTo(size[turn % 2 ? 2 : 0] * 6);
        expect(Math.min(...b.parts.map((p) => bounds(p).minz))).toBe(-24);
        expect(
          Math.max(...b.parts.map((p) => bounds(p).maxz)) + 24,
        ).toBeCloseTo(size[turn % 2 ? 0 : 2] * 6);
        expect(Math.min(...b.parts.map((p) => bounds(p).miny))).toBe(0);
        expect(Math.max(...b.parts.map((p) => bounds(p).maxy))).toBeCloseTo(
          size[1] * 2,
        );
        for (const a of b.parts)
          for (const c of b.parts)
            if (a.id !== c.id) expect(collision(a, c)).toBe(false);
      }
  });
  it("joins roof slopes at their high edges to form a ridge instead of a valley", () => {
    const b = compileBlueprint(design([row("roof", "gable-roof")]));
    const top = b.parts.flatMap((p) => mask(p)).filter((c) => c.y === 7);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((c) => c.z >= 10 && c.z <= 13)).toBe(true);
  });
  it("supports a four-wheel chassis on real bearing surfaces without fake stud connections", () => {
    const b = compileBlueprint(
      design([
        {
          ...row("axles", "wheel-axle", [-3, 0, -4], 1),
          repeat: { count: 2, step: [0, 0, 5] },
        },
        {
          ...row("decks", "plate-2x4", [-2, 6, -3.5], 1),
          repeat: { count: 2, step: [0, 0, 5] },
        },
        row("bridge", "plate-2x4", [-1, 7, -3]),
      ]),
    );
    expect(b.issues).toEqual([]);
    expect(
      b.edges.filter((e) => e.a.includes("mount") && e.b.includes("decks")),
    ).toEqual([]);
  });
  it("finds real bottom support transitively and rejects tiny corner contacts or gaps", () => {
    const b = compileBlueprint(
      design([
        row("floor", "plate-4x4"),
        row("beam", "beam-3", [0, 1, 0]),
        row("body", "brick-2x2", [1, 4, 0]),
      ]),
    );
    expect(b.issues).toEqual([]);
    expect(b.edges.some((e) => e.a === "beam" || e.b === "beam")).toBe(false);
    expect(
      compileBlueprint(
        design([
          row("base", "brick-1x1"),
          row("top", "brick-1x1", [5 / 6, 3, 5 / 6]),
        ]),
      ).issues.some((i) => i.code === "unattached"),
    ).toBe(true);
    expect(
      compileBlueprint(
        design([
          row("base", "brick-1x1"),
          row("top", "brick-1x1", [0, 3.5, 0]),
        ]),
      ).issues.some((i) => i.code === "unattached"),
    ).toBe(true);
  });
  it("rejects expanded overflows, duplicate row and expanded IDs, and colliding repeats", () => {
    expect(() =>
      expandDesign(
        design(
          Array.from({ length: 3 }, (_, i) => ({
            ...row(`row${i}`, "wheel-axle"),
            repeat: { count: 32, step: [4, 0, 0] },
          })),
        ),
      ),
    ).toThrow(`${MAX_AI_PARTS}`);
    expect(() =>
      expandDesign(
        design([row("same", "brick-1x1"), row("same", "brick-1x1")]),
      ),
    ).toThrow("Duplicate");
    expect(() =>
      expandDesign(
        design([
          { ...row("a", "brick-1x1"), repeat: { count: 2, step: [2, 0, 0] } },
          row("a_0", "brick-1x1"),
        ]),
      ),
    ).toThrow("IDs collide");
    expect(
      compileBlueprint(
        design([
          { ...row("a", "brick-1x1"), repeat: { count: 2, step: [0, 0, 0] } },
        ]),
      ).issues.some((i) => i.code === "overlap"),
    ).toBe(true);
  });
  it("checks the expanded rotated bounds rather than only an assembly origin", () => {
    expect(
      compileBlueprint(
        design([row("axle", "wheel-axle", [12, 0, 0], 1)]),
      ).issues.some((i) => i.code === "bounds"),
    ).toBe(true);
  });
  it("presents an explicitly declared doorway front toward the default camera", () => {
    for (const front of ["+z", "-z", "+x", "-x"] as const) {
      const at =
        front === "+z"
          ? [-2, 1, 1]
          : front === "-z"
            ? [-2, 1, -2]
            : front === "+x"
              ? [1, 1, -2]
              : [-2, 1, -2];
      const b = compileBlueprint({
        ...design([
          row("floor", "plate-4x4", [-2, 0, -2]),
          row("door", "arch", at, front.endsWith("x") ? 1 : 0),
        ]),
        front,
      });
      expect(b.issues).toEqual([]);
      expect(b.parts.find((p) => p.id === "door")!.position).toEqual({
        x: -12,
        y: 2,
        z: 6,
      });
      expect(b.edges.length).toBeGreaterThan(0);
    }
  });
});
