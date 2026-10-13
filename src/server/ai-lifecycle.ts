import { rawSql } from "@neon/realtime/server";
import { trustedRealtime } from "./live";

// Only a committed terminal state cancels inference. A reconnecting transport
// is not cancellation; the deadline and guarded writes remain independent.
export async function watchCancellation(
  id: string,
  controller: AbortController,
) {
  const rt = trustedRealtime();
  try {
    const sub = await rt.subscribe(
      rawSql<{ id: string; status: string }>(
        "SELECT id::text,status FROM ai_generations WHERE id=$1::uuid",
        [id],
      ),
    );
    let stopped = false;
    const receive = (snapshot: ReturnType<typeof sub.getSnapshot>) => {
      if (
        !stopped &&
        snapshot.status === "live" &&
        !["designing", "checking", "repairing"].includes(
          snapshot.data?.[0]?.status || "",
        )
      )
        controller.abort();
    };
    const off = sub.onChange(receive);
    receive(sub.getSnapshot());
    return () => {
      if (stopped) return;
      stopped = true;
      off();
      sub.unsubscribe();
      rt.close();
    };
  } catch (error) {
    rt.close();
    throw error;
  }
}
