import { describe, expect, it } from "vitest";
import {
  conversationRows,
  conversationState,
} from "../src/client/ai-conversation";
import type { AIConversationRow } from "../src/shared/types";

const row = (
  id: string,
  status: AIConversationRow["status"],
  time: string,
  author = "alice",
): AIConversationRow => ({
  id,
  status,
  created_at: time,
  author,
  author_name: author,
  attempt: 1,
  error: null,
  world: null,
  target: "workshop",
  prompt: "Change the model",
  model: "fixture",
  blueprint: null,
});
describe("Shared AI conversation snapshots", () => {
  it("discovers another author's prompt and selects its active build regardless of query order", () => {
    const jobs = conversationRows([
      row("bob-build", "designing", "2026-10-13T10:01:00Z", "bob"),
      row("alice-build", "accepted", "2026-10-13T10:00:00Z"),
    ]);
    expect(jobs.map((r) => r.id)).toEqual(["alice-build", "bob-build"]);
    expect(conversationState(jobs).job?.author).toBe("bob");
    expect(conversationState(jobs).preview).toBeNull();
  });
  it("keeps the shared valid draft during a refinement and after failure", () => {
    for (const status of ["designing", "failed", "cancelled"] as const) {
      const jobs = conversationRows([
        row("draft", "ready", "2026-10-13T10:00:00Z"),
        row("refinement", status, "2026-10-13T10:01:00Z", "bob"),
      ]);
      expect(conversationState(jobs).preview?.id).toBe("draft");
    }
  });
  it("clears an earlier preview on peer application and all state on membership withdrawal", () => {
    const jobs = conversationRows([
      row("draft", "ready", "2026-10-13T10:00:00Z"),
      row("refinement", "accepted", "2026-10-13T10:01:00Z", "bob"),
    ]);
    expect(conversationState(jobs).preview).toBeNull();
    expect(conversationState(conversationRows([]))).toEqual({
      job: null,
      preview: null,
    });
  });
  it("uses the ready preview and keeps partial drawings separate from validated parts", () => {
    const piece = {
      id: "p0",
      key: "brick-2x2",
      color: "#289b74",
      rotation: 0,
      position: { x: 0, y: 0, z: 0 },
      revision: 1,
    };
    for (const status of ["checking", "ready"] as const) {
      const jobs = conversationRows([
        {
          ...row("draft", status, "2026-10-13T10:00:00Z"),
          preview: { parts: [piece], title: "Tower" },
        },
      ]);
      expect(jobs[0].parts).toHaveLength(status === "ready" ? 1 : 0);
      expect(jobs[0].preview?.parts).toHaveLength(1);
    }
  });
});

it("reuses historic exchange objects while an active drawing changes", () => {
  const history = row("applied", "accepted", "2026-10-13T10:00:00Z");
  const busy = row("drawing", "designing", "2026-10-13T10:01:00Z");
  const previous = conversationRows([history, busy]);
  const next = conversationRows(
    [{ ...history }, { ...busy, activity: "Drawing 20 pieces" }],
    previous,
  );
  expect(next[0]).toBe(previous[0]);
  expect(next[1]).not.toBe(previous[1]);
});
