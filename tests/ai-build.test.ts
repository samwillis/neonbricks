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
  it("patches only affected rows and accounts for each inference exactly once", async () => {
    const design = {
      version: 2,
      title: "Tower",
      summary: "A tower",
      pieces: [
        {
          id: "tower",
          part: "brick-2x2",
          colour: "jade",
          turn: 0,
          at: [0, 3, 0],
          repeat: null,
        },
      ],
    };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(candidate(design))
      .mockResolvedValueOnce(
        candidate({
          title: null,
          summary: null,
          changes: [
            { id: "tower", row: { ...design.pieces[0], at: [0, 0, 0] } },
          ],
        }),
      );
    const report = vi.fn();
    const b = await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      report,
    );
    expect(b.issues).toEqual([]);
    expect(generate.mock.calls[1][4]).toEqual(design);
    expect(generate.mock.calls[1][1]).toContain("only a patch");
    expect(
      report.mock.calls.reduce((n, c) => n + (c[2]?.inputTokens || 0), 0),
    ).toBe(20);
  });
  it("refines a saved compact design without regenerating unaffected pieces", async () => {
    const design = {
      version: 2,
      title: "Tower",
      summary: "A tower",
      pieces: [
        {
          id: "tower",
          part: "brick-2x2",
          colour: "jade",
          turn: 0,
          at: [0, 0, 0],
          repeat: { count: 3, step: [0, 3, 0] },
        },
        {
          id: "roof",
          part: "slope-2x2",
          colour: "poppy",
          turn: 0,
          at: [0, 9, 0],
          repeat: null,
        },
      ],
    };
    const generate = vi.fn().mockResolvedValue(
      candidate({
        title: null,
        summary: "A blue-roofed tower",
        changes: [
          { id: "roof", row: { ...design.pieces[1], colour: "cobalt" } },
        ],
      }),
    );
    const b = await buildCandidate(
      "Make its roof blue",
      "test",
      new AbortController().signal,
      generate,
      vi.fn(),
      design,
    );
    expect(b.issues).toEqual([]);
    expect(
      b.parts.filter((p) => p.id.startsWith("tower")).map((p) => p.position.y),
    ).toEqual([0, 6, 12]);
    expect(b.parts.find((p) => p.id === "roof")!.color).toBe("#486fa4");
    expect(generate.mock.calls[0][4]).toEqual(design);
  });
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
    ).rejects.toThrow("1 piece without support after three design passes");
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it("rejects a worse patch and repairs the best design, while recording all usage", async () => {
    const design = {
      version: 2,
      title: "Tower",
      summary: "A tower",
      front: "+z",
      pieces: [
        {
          id: "base",
          part: "brick-2x2",
          colour: "jade",
          turn: 0,
          at: [0, 0, 0],
          repeat: null,
        },
        {
          id: "cap",
          part: "brick-2x2",
          colour: "poppy",
          turn: 0,
          at: [0, 6, 0],
          repeat: null,
        },
      ],
    };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(candidate(design))
      .mockResolvedValueOnce(
        candidate({
          title: null,
          summary: null,
          changes: [
            { id: "base", row: { ...design.pieces[0], at: [0, 6, 0] } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        candidate({
          title: null,
          summary: null,
          changes: [{ id: "cap", row: { ...design.pieces[1], at: [0, 3, 0] } }],
        }),
      );
    const report = vi.fn();
    const built = await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      report,
    );
    expect(built.issues).toEqual([]);
    expect(generate.mock.calls[2][4]).toEqual(design);
    expect(generate.mock.calls[2][1]).toContain("was discarded");
    const rejected = report.mock.calls.find((c) => c[0] === 2 && c[2]);
    expect(rejected?.[2].retainedPrevious).toBe(true);
    expect(rejected?.[2].issueCounts.overlap).toBe(1);
    expect(rejected?.[2].bestIssueCounts).toEqual({ unattached: 1 });
    expect(
      report.mock.calls.reduce((n, c) => n + (c[2]?.inputTokens || 0), 0),
    ).toBe(30);
  });
  it("keeps the repair baseline when a patch fails expansion", async () => {
    const design = {
      version: 2,
      title: "Tower",
      summary: "",
      pieces: [
        {
          id: "tower",
          part: "brick-2x2",
          colour: "jade",
          turn: 0,
          at: [0, 6, 0],
          repeat: null,
        },
      ],
    };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(candidate(design))
      .mockResolvedValueOnce(
        candidate({
          title: null,
          summary: null,
          changes: [
            {
              id: "tooBig",
              row: {
                ...design.pieces[0],
                id: "tooBig",
                part: "pine-tree",
                repeat: { count: 32, step: [1, 0, 0] },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        candidate({
          title: null,
          summary: null,
          changes: [
            { id: "tower", row: { ...design.pieces[0], at: [0, 0, 0] } },
          ],
        }),
      );
    const built = await buildCandidate(
      "Tower",
      "test",
      new AbortController().signal,
      generate,
      vi.fn(),
    );
    expect(built.issues).toEqual([]);
    expect(generate.mock.calls[2][4]).toEqual(design);
    expect(built.parts).toHaveLength(1);
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
    expect(generate.mock.calls[1][1]).toContain("validation");
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildCandidate("Tower", "test", controller.signal, generate, vi.fn()),
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
