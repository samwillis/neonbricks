import type {
  RealtimeClient,
  SealedLiveQuery,
  MaterializedLiveQuerySubscription,
} from "@neon/realtime/client";

export type QueryState = { status: string; error?: string };
export type QuerySnapshot<T> = QueryState & { data: readonly T[] };

// Capability issuance must continue even when the socket cannot acknowledge a
// renewal. Keep the expiry clock injectable: browser wall clocks can be wrong.
export async function openLiveQuery<T>({
  client,
  fetchQuery,
  now,
  active = () => true,
  receive,
}: {
  client: RealtimeClient;
  fetchQuery: (signal: AbortSignal) => Promise<SealedLiveQuery<T>>;
  now: () => number;
  active?: () => boolean;
  receive: (snapshot: QuerySnapshot<T>) => void;
}): Promise<{ sub: MaterializedLiveQuerySubscription<T>; stop: () => void }> {
  const abort = new AbortController();
  let query: SealedLiveQuery<T>;
  for (;;) {
    try {
      query = await fetchQuery(abort.signal);
      break;
    } catch (error) {
      if (
        !active() ||
        [401, 403].includes((error as { status?: number }).status || 0)
      )
        throw error;
      receive({ data: [], status: "stale", error: (error as Error).message });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!active())
        throw new DOMException("Subscription disposed", "AbortError");
    }
  }
  if (!active()) throw new DOMException("Subscription disposed", "AbortError");
  const sub = client.subscribe(query);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !stopped && active();
  const forward = (snapshot: ReturnType<typeof sub.getSnapshot>) => {
    if (!current()) return;
    if (snapshot.status === "error" && snapshot.error?.retryable === false) {
      terminate(snapshot.error);
      return;
    }
    receive({
      data: snapshot.data || [],
      status: snapshot.status,
      error: snapshot.error?.message,
    });
  };
  const off = sub.onChange(forward);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    abort.abort();
    off();
    sub.unsubscribe();
  };
  const denied = (error: unknown) =>
    [401, 403].includes((error as { status?: number }).status || 0);
  const schedule = (
    delay = Math.max(1000, query.expiresAt - now() - 12000),
  ) => {
    clearTimeout(timer);
    if (current()) timer = setTimeout(() => void refresh(), delay);
  };
  const refresh = async () => {
    try {
      const next = await fetchQuery(abort.signal);
      if (!current()) return;
      if (next.queryFingerprint !== query.queryFingerprint)
        throw Object.assign(
          new Error("Live query changed; reload the workshop."),
          { status: 403 },
        );
      query = next;
      schedule();
      // Do not await wire acceptance. Only the latest failure can accelerate
      // refresh; an obsolete renewal must never replace a newer schedule.
      void sub
        .renew(next)
        .then(() => {
          if (current() && query === next) forward(sub.getSnapshot());
        })
        .catch((error) => {
          if (!current() || query !== next) return;
          if (denied(error)) terminate(error);
          else schedule(1000);
        });
    } catch (error) {
      if (!current()) return;
      if (denied(error)) terminate(error);
      else {
        receive({
          data: sub.getSnapshot().data || [],
          status: "stale",
          error: (error as Error).message,
        });
        schedule(1000);
      }
    }
  };
  const terminate = (error: unknown) => {
    stop();
    receive({ data: [], status: "error", error: (error as Error).message });
  };
  forward(sub.getSnapshot());
  schedule();
  return { sub, stop };
}
