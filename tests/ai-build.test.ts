import { describe, expect, it, vi } from "vitest";
vi.mock("../src/server/db", () => ({ pool: {}, transaction: vi.fn() }));
import { buildCandidate } from "../src/server/ai";
const good = {
  version: 1,
  catalogue: "workshop-1",
  title: "Tower",
  summary: "A tower.",
  parts: [
    {
      id: "base",
      part: "brick-1x1",
      colour: "jade",
      at: [0, 0, 0],
      turn: 0,
      attach: null,
    },
  ],
};
const candidate = (blueprint: unknown) => ({
  blueprint,
  inputTokens: 10,
  outputTokens: 10,
});
describe("AI generation repair loop", () => {
  it("accepts a valid candidate on the first call", async () => {
    const generate = vi.fn().mockResolvedValue(candidate(good));
    const result = await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      vi.fn(),
    );
    expect(result.issues).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("returns specific validation errors and repairs the complete model", async () => {
    const bad = { ...good, parts: [{ ...good.parts[0], at: [0, 3, 0] }] };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(candidate(bad))
      .mockResolvedValueOnce(candidate(good));
    await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      vi.fn(),
    );
    expect(generate.mock.calls[1][1]).toContain("unattached");
    expect(generate.mock.calls[1][1]).toContain("base");
  });
  it("stops after three candidates", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(
        candidate({ ...good, parts: [{ ...good.parts[0], at: [0, 3, 0] }] }),
      );
    await expect(
      buildCandidate(
        "Tower",
        "test",
        new AbortController().signal,
        generate,
        vi.fn(),
      ),
    ).rejects.toThrow("couldn't get all the pieces to fit");
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it("repairs schema errors and honours cancellation before more inference", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(candidate({ version: 2 }))
      .mockResolvedValueOnce(candidate(good));
    await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      vi.fn(),
    );
    expect(generate.mock.calls[1][1]).toContain("schema");
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildCandidate("Tower", "test", controller.signal, generate, vi.fn()),
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
