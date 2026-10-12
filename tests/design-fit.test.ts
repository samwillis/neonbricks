import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapDesign } from "../src/shared/design-fit";
import { compileBlueprint } from "../src/shared/blueprint";
import { designSchema, type Design } from "../src/shared/design";

const rover = designSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/ai-rover-missed-antenna.json", import.meta.url),
      "utf8",
    ),
  ),
);
describe("bounded AI stud snapping", () => {
  it("fixes the observed three-piece antenna without changing the rover", () => {
    for (const front of [undefined, "+z", "-z", "+x", "-x"] as const) {
      const original = { ...rover, front };
      expect(compileBlueprint(original).issues).toHaveLength(3);
      const fit = snapDesign(original);
      expect(fit.compiled.issues).toEqual([]);
      expect(fit.adjustments).toHaveLength(1);
      expect(fit.adjustments[0].rows).toEqual(["ant1", "ant2"]);
      expect(fit.adjustments[0].shift.slice(0, 2)).toEqual([0, 0]);
      expect(Math.abs(fit.adjustments[0].shift[2])).toBe(1);
      expect(fit.design.pieces.filter((p) => !p.id.startsWith("ant"))).toEqual(
        original.pieces.filter((p) => !p.id.startsWith("ant")),
      );
      expect(original.pieces.find((p) => p.id === "ant1")!.at).toEqual([
        1, 17, 0,
      ]);
    }
  });
  it("does not delete details, move parts far away, or fix overlaps by weakening checks", () => {
    const row: Design["pieces"][number] = {
      id: "base",
      part: "brick-1x1",
      colour: "jade",
      turn: 0,
      at: [0, 0, 0],
      repeat: null,
    };
    for (const at of [
      [3, 3, 0],
      [0, 0, 0],
      [0, 6, 0],
    ]) {
      const d: Design = {
        version: 2,
        title: "Fixture",
        summary: "",
        pieces: [row, { ...row, id: "detail", at }],
      };
      const fit = snapDesign(d);
      expect(fit.adjustments).toEqual([]);
      expect(fit.compiled.issues.length).toBeGreaterThan(0);
      expect(fit.design).toEqual(d);
    }
  });
  it("leaves partially grounded repeat rows in place", () => {
    const d: Design = {
      version: 2,
      title: "Fixture",
      summary: "",
      pieces: [
        {
          id: "base",
          part: "brick-1x1",
          colour: "jade",
          turn: 0,
          at: [0, 0, 0],
          repeat: null,
        },
        {
          id: "caps",
          part: "brick-1x1",
          colour: "jade",
          turn: 0,
          at: [0, 3, 0],
          repeat: { count: 2, step: [1, 0, 0] },
        },
      ],
    };
    const fit = snapDesign(d);
    expect(fit.adjustments).toEqual([]);
    expect(fit.compiled.issues).toHaveLength(1);
  });
});
