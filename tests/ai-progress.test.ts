import { describe, expect, it } from "vitest";
import { newerGeneration } from "../src/client/ai-progress";
import type { AIGenerationProgress } from "../src/shared/types";

const progress = (
  status: AIGenerationProgress["status"],
  attempt = 1,
): AIGenerationProgress => ({
  id: "draft",
  status,
  attempt,
  world: null,
  error: null,
});
describe("AI preview response ordering", () => {
  it("cannot undo cancellation, failure or acceptance with a delayed response", () => {
    for (const terminal of ["cancelled", "failed", "accepted"] as const)
      for (const incoming of ["designing", "checking", "ready"] as const)
        expect(newerGeneration(progress(terminal), progress(incoming))).toBe(
          false,
        );
    expect(newerGeneration(progress("ready"), progress("accepted"))).toBe(true);
    expect(newerGeneration(progress("ready"), progress("cancelled"))).toBe(
      true,
    );
    expect(newerGeneration(progress("ready"), progress("checking"))).toBe(
      false,
    );
  });
  it("accepts the next repair but ignores an earlier poll or Realtime stage", () => {
    expect(newerGeneration(progress("checking"), progress("designing"))).toBe(
      false,
    );
    expect(
      newerGeneration(progress("checking"), progress("repairing", 2)),
    ).toBe(true);
    expect(
      newerGeneration(progress("repairing", 2), progress("checking", 1)),
    ).toBe(false);
    expect(
      newerGeneration(
        { ...progress("ready"), updated_at: "2026-10-13T00:00:02Z" },
        { ...progress("ready"), updated_at: "2026-10-13T00:00:01Z" },
      ),
    ).toBe(false);
    // A full REST fetch can fill preview parts at the same version as a live event.
    expect(newerGeneration(progress("ready"), progress("ready"))).toBe(true);
  });
});
