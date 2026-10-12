import type { AIGenerationProgress } from "../shared/types";

// HTTP responses and live snapshots can arrive out of order. Terminal states
// cannot become active again, and a stale poll must not undo cancellation.
export function newerGeneration(
  previous: AIGenerationProgress | null,
  next: AIGenerationProgress,
) {
  if (!previous || previous.id !== next.id) return true;
  if (
    ["accepted", "cancelled", "failed"].includes(previous.status) &&
    next.status !== previous.status
  )
    return false;
  if (
    previous.status === "ready" &&
    !["ready", "accepted", "cancelled"].includes(next.status)
  )
    return false;
  if (
    previous.updated_at &&
    next.updated_at &&
    Date.parse(next.updated_at) < Date.parse(previous.updated_at)
  )
    return false;
  if (next.attempt < previous.attempt) return false;
  const order: Record<string, number> = {
    queued: 0,
    designing: 1,
    repairing: 1,
    checking: 2,
  };
  return (
    next.attempt !== previous.attempt ||
    !(next.status in order && previous.status in order) ||
    order[next.status] >= order[previous.status]
  );
}
