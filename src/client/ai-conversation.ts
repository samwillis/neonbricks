import type { AIConversationRow, AIGeneration } from "../shared/types";

export const activeAIStates = ["queued", "designing", "checking", "repairing"];

// The live query is authoritative for the entire conversation, including new
// prompts from other devices and rows removed by a membership withdrawal.
export function conversationRows(
  rows: readonly AIConversationRow[],
): AIGeneration[] {
  return [...rows]
    .sort(
      (a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      ...row,
      parts: ["ready", "accepted"].includes(row.status)
        ? row.preview?.parts || []
        : [],
    }));
}

export function conversationState(jobs: AIGeneration[]) {
  const job =
    jobs.filter((r) => activeAIStates.includes(r.status)).at(-1) ||
    jobs.at(-1) ||
    null;
  const lastApplied = jobs.map((r) => r.status).lastIndexOf("accepted");
  const preview =
    jobs
      .slice(lastApplied + 1)
      .filter((r) => r.status === "ready")
      .at(-1) || null;
  return { job, preview };
}
