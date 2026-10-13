import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileBlueprint } from "../src/shared/blueprint";
import { designSchema } from "../src/shared/design";
import {
  fitFailureMessage,
  fitRepairFeedback,
  fitScore,
} from "../src/shared/design-repair";
const lookout = designSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/ai-lookout-fit-errors.json", import.meta.url),
      "utf8",
    ),
  ),
);
describe("AI fit feedback", () => {
  it("maps repeated and assembled pieces back to source rows in the source coordinate frame", () => {
    for (const front of ["+z", "-z", "+x", "-x"] as const) {
      const design = { ...lookout, front };
      const feedback = fitRepairFeedback(compileBlueprint(design), design);
      expect(feedback).toContain(
        '"id":"leftLowF_0","row":"leftLowF","x":[-4,-2],"y":[15,18],"z":[3,4]',
      );
      expect(feedback).toContain('"id":"step6","row":"step6"');
      expect(feedback).toContain("stair landings");
      expect(feedback).toContain("split repeat rows");
    }
  });
  it("compares the full issue count beyond the thirty displayed examples", () => {
    const crowded = {
      ...lookout,
      pieces: Array.from({ length: 40 }, (_, i) => ({
        ...lookout.pieces[0],
        id: `base${i}`,
        repeat: null,
      })),
    };
    const compiled = compileBlueprint(crowded);
    expect(compiled.issues).toHaveLength(30);
    expect(compiled.issueCounts.overlap).toBe(39);
    expect(fitScore(compiled)).toBe(156);
  });
  it("explains the fit failure without blaming the prompt or losing validation detail", () => {
    const message = fitFailureMessage(compileBlueprint(lookout));
    expect(message).toContain(
      "12 overlapping piece pairs and 3 pieces without support",
    );
    expect(message).toContain("Your model is unchanged");
    expect(message).not.toContain("simpler");
    expect(fitFailureMessage()).toContain("incomplete design");
  });
});
