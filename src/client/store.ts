import {
  createRealtimeClient,
  type MaterializedLiveQuerySubscription,
  type SealedLiveQuery,
} from "@neon/realtime/client";
import { useSyncExternalStore } from "react";
import { COLORS } from "../shared/catalogue";
import type {
  World,
  Part,
  Connection,
  Viewer,
  SceneRow,
  Preview,
  Position,
  Edit,
  Receipt,
  AIConversationRow,
  Member,
} from "../shared/types";
import {
  openLiveQuery,
  type QueryState,
  type QuerySnapshot,
} from "./live-query";
import { sceneEntity } from "../shared/types";
type Pending = {
  id: string;
  generation: number;
  parts: Part[];
  receipt?: Receipt;
};
type State = {
  world: World | null;
  parts: Part[];
  connections: Connection[];
  viewers: Viewer[];
  status: string;
  error: string | null;
  guest: string;
  name: string;
  color: string;
  canReset: boolean;
  canBuildAI: boolean;
  role: string | null;
  queries: Record<"presence" | "history" | "member", QueryState>;
  pending: Pending[];
  history: { undo: string | null; redo: string | null };
  lastTx: string | null;
  serverOffset: number;
};
let state: State = {
  world: null,
  parts: [],
  connections: [],
  viewers: [],
  status: "connecting",
  error: null,
  guest: "",
  name: "",
  color: COLORS[0].hex,
  canReset: false,
  canBuildAI: false,
  role: null,
  queries: {
    presence: { status: "connecting" },
    history: { status: "connecting" },
    member: { status: "connecting" },
  },
  pending: [],
  history: { undo: null, redo: null },
  lastTx: null,
  serverOffset: 0,
};
const listeners = new Set<() => void>();
export const getState = () => state;
function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
export function useWorkshop() {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, getState);
}
const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
let token = sessionStorage.getItem("neon-bricks-session") || "";
let viewer = "",
  sequence = 0,
  client: ReturnType<typeof createRealtimeClient> | undefined,
  scene: MaterializedLiveQuerySubscription<SceneRow> | undefined;
let startAbort: AbortController | undefined;
let disposed = false,
  epoch = 0,
  subscriptions = new Set<() => void>(),
  heartTimer: ReturnType<typeof setInterval> | undefined,
  sessionTimer: ReturnType<typeof setInterval> | undefined;
let clock = { server: Date.now(), mono: performance.now() };
export const serverNow = () => clock.server + performance.now() - clock.mono;
export const getViewerId = () => viewer;
let rejoining = false;
let liveHistory:
  { undo: string | null; redo: string | null; generation: number } | undefined;
let intent: {
    preview: Preview | null;
    selection: string[];
    cursor: Position | null;
  } = {
    preview: null,
    selection: [],
    cursor: null,
  },
  lastIntent = "",
  lastSample = 0,
  presenceTimer: ReturnType<typeof setTimeout> | undefined,
  presenceFlight: number | null = null;
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sent = performance.now(),
    response = await fetch(`${API}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  const data = await response.json();
  if (!response.ok) {
    const e = new Error(
      data.error || `Request failed (${response.status})`,
    ) as Error & { status: number };
    e.status = response.status;
    throw e;
  }
  const elapsed = performance.now() - sent;
  // A long AI invocation includes inference time, not just network latency.
  // It must not move the presence clock forward by half the generation time.
  if (data.serverTime && elapsed < 5000) {
    clock = {
      server: data.serverTime + elapsed / 2,
      mono: performance.now(),
    };
    publish({ serverOffset: clock.server - Date.now() });
  }
  return data;
}
export function notice(message: string | null) {
  publish({ error: message });
}
export async function watchConversation(
  world: string,
  receive: (snapshot: QuerySnapshot<AIConversationRow>) => void,
  signal?: AbortSignal,
) {
  if (!client)
    throw new Error("Wait for the workshop to connect, then try again.");
  const currentClient = client,
    run = epoch;
  const live = await openLiveQuery({
    client: currentClient,
    fetchQuery: (refreshSignal) =>
      api<SealedLiveQuery<AIConversationRow>>(`/worlds/${world}/live/ai`, {
        signal: signal
          ? AbortSignal.any([signal, refreshSignal])
          : refreshSignal,
      }),
    now: serverNow,
    active: () =>
      !disposed &&
      run === epoch &&
      client === currentClient &&
      !signal?.aborted,
    receive,
  });
  const stop = () => {
    live.stop();
    subscriptions.delete(stop);
    signal?.removeEventListener("abort", stop);
  };
  subscriptions.add(stop);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return stop;
}
export async function start(slug: string) {
  startAbort?.abort();
  const abort = new AbortController();
  startAbort = abort;
  subscriptions.forEach((off) => off());
  subscriptions.clear();
  client?.close();
  clearInterval(heartTimer);
  clearInterval(sessionTimer);
  publish({
    status: "connecting",
    error: null,
    role: null,
    canBuildAI: false,
    canReset: false,
    history: { undo: null, redo: null },
    pending: [],
    viewers: [],
    parts: [],
    connections: [],
    queries: {
      presence: { status: "connecting" },
      history: { status: "connecting" },
      member: { status: "connecting" },
    },
  });
  disposed = false;
  const run = ++epoch,
    active = () => !disposed && run === epoch;
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  presenceFlight = null;
  sequence = 0;
  liveHistory = undefined;
  lastIntent = "";
  intent = { preview: null, selection: [], cursor: null };
  try {
    if (!token) {
      const name = `Builder ${Math.floor(Math.random() * 900 + 100)}`,
        color = COLORS[Math.floor(Math.random() * 6)].hex;
      const session = await api<{ token: string }>("/session", {
        method: "POST",
        body: JSON.stringify({ name, color }),
        signal: abort.signal,
      });
      if (!active()) return;
      token = session.token;
      sessionStorage.setItem("neon-bricks-session", token);
    }
    let joined: any;
    try {
      joined = await api(`/worlds/${slug}/join`, {
        method: "POST",
        signal: abort.signal,
      });
    } catch (e) {
      if (!active()) return;
      if ((e as any).status === 401) {
        token = "";
        sessionStorage.removeItem("neon-bricks-session");
        return start(slug);
      }
      throw e;
    }
    if (!active()) return;
    viewer = joined.viewer;
    publish({
      world: joined.world,
      guest: joined.guest,
      name: joined.name,
      color: joined.color,
      // Permissions are enabled only after live member metadata arrives.
    });
    const url = import.meta.env.VITE_NEON_REALTIME_URL;
    if (!url) throw new Error("Realtime URL is missing. Check .env.local.");
    client = createRealtimeClient({ url });
    const subscribe = async <T>(
      kind: string,
      receive: (data: readonly T[], status: string, error?: string) => void,
    ) => {
      try {
        const live = await openLiveQuery({
          client: client!,
          fetchQuery: (signal) =>
            api<SealedLiveQuery<T>>(`/worlds/${joined.world.id}/live/${kind}`, {
              signal: AbortSignal.any([signal, abort.signal]),
            }),
          now: serverNow,
          active,
          receive: ({ data, status, error }) => receive(data, status, error),
        });
        subscriptions.add(live.stop);
        return live.sub;
      } catch (error) {
        if (active()) receive([], "error", (error as Error).message);
        return undefined;
      }
    };
    const sceneSubscription = await subscribe<SceneRow>(
      "scene",
      (rows, status, error) => {
        const headerRow = rows.find((r) => r.kind === "world"),
          header = headerRow ? (sceneEntity(headerRow) as World) : undefined;
        const parts = rows
            .filter((r) => r.kind === "part")
            .map((r) => sceneEntity(r) as Part),
          connections = rows
            .filter((r) => r.kind === "connection")
            .map((r) => sceneEntity(r) as Connection);
        if (
          header &&
          state.world &&
          header.generation !== state.world.generation
        ) {
          intent = { preview: null, selection: [], cursor: null };
          lastIntent = "";
          publish({ pending: [], history: { undo: null, redo: null } });
        }
        const pending = state.pending.filter(
          (p) =>
            !p.receipt?.accepted ||
            !p.parts.every((part) =>
              part.deleted
                ? !parts.some((x) => x.id === part.id)
                : parts.some(
                    (x) => x.id === part.id && x.revision >= part.revision,
                  ),
            ),
        );
        if (status === "live" && !header) {
          publish({
            parts: [],
            connections: [],
            pending: [],
            status: "error",
            error: "Workshop access ended. Reload to rejoin.",
          });
          return;
        }
        publish({
          ...(header ? { world: header } : {}),
          parts,
          connections,
          pending,
          ...(status === "live" && header
            ? {
                history:
                  liveHistory?.generation === header.generation
                    ? { undo: liveHistory.undo, redo: liveHistory.redo }
                    : { undo: null, redo: null },
              }
            : {}),
          status,
          ...(error
            ? { error }
            : status === "live" && state.status !== "live"
              ? { error: null }
              : {}),
        });
      },
    );
    if (!active()) return;
    scene = sceneSubscription;
    const queryState = (
      kind: "presence" | "history" | "member",
      status: string,
      error?: string,
    ) => ({
      ...state.queries,
      [kind]: { status, error },
    });
    const presenceSubscription = subscribe<Viewer>(
      "presence",
      (rows, status, error) => {
        publish({
          queries: queryState("presence", status, error),
          ...(status === "live" || status === "error"
            ? { viewers: [...rows] }
            : {}),
        });
      },
    );
    const historySubscription = subscribe<{
      undo: string | null;
      redo: string | null;
      generation: number;
    }>("history", (rows, status, error) => {
      if (status === "live" || status === "error") liveHistory = rows[0];
      publish({
        queries: queryState("history", status, error),
        ...(status === "live" || status === "error"
          ? {
              history:
                rows[0] && rows[0].generation === state.world?.generation
                  ? { undo: rows[0].undo, redo: rows[0].redo }
                  : { undo: null, redo: null },
            }
          : {}),
      });
    });
    const memberSubscription = subscribe<Member>(
      "member",
      (rows, status, error) => {
        const member = rows[0];
        publish({
          queries: queryState("member", status, error),
          ...(status === "live"
            ? {
                name: member?.name || "",
                color: member?.color || COLORS[0].hex,
                role: member?.role || null,
              }
            : {}),
          canBuildAI: status === "live" && member?.role === "editor",
          canReset: status === "live" && member?.can_reset === true,
        });
      },
    );
    if (!active()) return;
    heartTimer = setInterval(() => {
      if (document.visibilityState === "visible") void sendPresence(false);
    }, 10_000);
    sessionTimer = setInterval(() => {
      if (document.visibilityState === "visible")
        void api("/session/renew", { method: "POST" }).catch((e) =>
          publish({ status: "error", error: e.message }),
        );
    }, 5 * 60_000);
    await sendPresence(false);
    await Promise.all([
      presenceSubscription,
      historySubscription,
      memberSubscription,
    ]);
  } catch (e) {
    if (active()) publish({ status: "error", error: (e as Error).message });
  }
}
export function stop() {
  startAbort?.abort();
  disposed = true;
  ++epoch;
  subscriptions.forEach((off) => off());
  subscriptions.clear();
  clearInterval(heartTimer);
  clearInterval(sessionTimer);
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  client?.close();
  client = undefined;
  scene = undefined;
  if (viewer && state.world)
    void api(`/worlds/${state.world.id}/viewers/${viewer}`, {
      method: "DELETE",
    }).catch(() => {});
}
export function setIntent(preview: Preview | null, selection: string[]) {
  intent = { ...intent, preview, selection };
  queuePresence();
}
export function setCursor(cursor: Position | null) {
  intent = { ...intent, cursor };
  queuePresence();
}
function queuePresence(delay = 0) {
  if (
    disposed ||
    state.status === "error" ||
    presenceTimer ||
    presenceFlight === epoch
  )
    return;
  presenceTimer = setTimeout(
    () => {
      presenceTimer = undefined;
      void sendPresence(true);
    },
    Math.max(delay, 200 - (performance.now() - lastSample)),
  );
}
export async function sendPresence(sample: boolean) {
  if (
    !viewer ||
    !state.world ||
    state.world.status !== "open" ||
    state.status === "error" ||
    disposed ||
    presenceFlight === epoch
  )
    return;
  const current = JSON.stringify(intent),
    now = performance.now();
  if (sample && now - lastSample < 200) {
    queuePresence(200 - (now - lastSample));
    return;
  }
  if (
    sample &&
    current === lastIntent &&
    ((!intent.preview && !intent.cursor) || now - lastSample < 1000)
  )
    return;
  if (sample) {
    lastIntent = current;
    lastSample = now;
  }
  const run = epoch;
  presenceFlight = run;
  let failed = false;
  try {
    await api(`/worlds/${state.world.id}/presence`, {
      method: "POST",
      body: JSON.stringify({
        viewer,
        sequence: ++sequence,
        generation: state.world.generation,
        ...intent,
        sample,
      }),
    });
  } catch (e) {
    if (disposed || run !== epoch) return;
    failed = true;
    if (sample) lastIntent = "";
    if ((e as any).status === 401 || (e as any).status === 403) {
      publish({ status: "error", error: (e as Error).message });
      return;
    }
    if ((e as any).status === 410 && !rejoining) {
      rejoining = true;
      try {
        const joined = await api<any>(`/worlds/${state.world.slug}/join`, {
          method: "POST",
        });
        if (disposed || run !== epoch) return;
        viewer = joined.viewer;
        sequence = 0;
        lastIntent = "";
      } catch (error) {
        publish({ status: "stale", error: (error as Error).message });
      } finally {
        rejoining = false;
      }
    }
  } finally {
    if (run === epoch) {
      presenceFlight = null;
      // Only the newest pointer position waits behind a slow request.
      if (JSON.stringify(intent) !== lastIntent)
        queuePresence(failed ? 1000 : 0);
    }
  }
}
export function displayParts() {
  const map = new Map(state.parts.map((p) => [p.id, p]));
  for (const p of state.pending.flatMap((p) => p.parts)) {
    if (p.deleted) map.delete(p.id);
    else map.set(p.id, p);
  }
  return [...map.values()];
}
export async function submit(
  request: Omit<Edit, "operationId" | "generation">,
) {
  if (
    !state.world ||
    state.world.status !== "open" ||
    state.status !== "live" ||
    state.queries.member.status !== "live" ||
    state.role !== "editor" ||
    (request.action !== "edit" && state.queries.history.status !== "live")
  ) {
    notice("Wait for the live connection before editing.");
    return false;
  }
  const run = epoch;
  const world = state.world,
    edit: Edit = {
      ...request,
      operationId: crypto.randomUUID(),
      generation: world.generation,
    };
  const touch = edit.changes?.map((c) => c.id) || [];
  if (
    state.pending.some((p) => p.parts.some((part) => touch.includes(part.id)))
  ) {
    notice("That part is still being saved.");
    return false;
  }
  const optimistic = (edit.changes || [])
    .map((change) => {
      const old = state.parts.find((p) => p.id === change.id);
      return { ...old, ...change, revision: (old?.revision || 0) + 1 } as Part;
    })
    .filter((p) => p.key && p.color && p.position);
  publish({
    pending: [
      ...state.pending,
      { id: edit.operationId, generation: world.generation, parts: optimistic },
    ],
    error: null,
  });
  let receipt: Receipt | undefined;
  for (let i = 0; i < 3; i++)
    try {
      receipt = await api(`/worlds/${world.id}/edit`, {
        method: "POST",
        body: JSON.stringify(edit),
      });
      break;
    } catch (e) {
      if ((e as any).status && (e as any).status !== 503) {
        notice((e as Error).message);
        break;
      }
    }
  if (!receipt) {
    try {
      receipt = await api<Receipt>(
        `/worlds/${world.id}/operations/${edit.operationId}`,
      );
    } catch {
      notice("Waiting for confirmation from Postgres…");
      void recover(edit, world.id);
      return false;
    }
  }
  if (!receipt) {
    notice("Waiting for confirmation from Postgres…");
    void recover(edit, world.id);
    return false;
  }
  if (disposed || run !== epoch) return false;
  if (!receipt.accepted) {
    publish({
      pending: state.pending.filter((p) => p.id !== edit.operationId),
      error: receipt.error || "Edit conflicted",
    });
    return false;
  }
  if (state.world?.generation !== receipt.generation) return true;
  publish({
    pending: state.pending.map((p) =>
      p.id === edit.operationId
        ? { ...p, parts: receipt!.parts || [], receipt }
        : p,
    ),
    lastTx: receipt.txid || null,
  });
  try {
    if (receipt.txid) await scene?.awaitTxId(receipt.txid, 5000);
    if (disposed || run !== epoch) return true;
    publish({
      pending: state.pending.filter((p) => p.id !== edit.operationId),
    });
  } catch {
    if (disposed || run !== epoch) return true;
    const actual = scene?.getSnapshot();
    if (
      actual?.status === "live" &&
      receipt.parts?.every((p) =>
        p.deleted
          ? !state.parts.some((x) => x.id === p.id)
          : state.parts.some((x) => x.id === p.id && x.revision >= p.revision),
      )
    )
      publish({
        pending: state.pending.filter((p) => p.id !== edit.operationId),
      });
    else notice("Saved in Postgres; waiting for the live scene to catch up.");
  }
  return true;
}
async function recover(edit: Edit, world: string) {
  const run = epoch;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (
      disposed ||
      run !== epoch ||
      state.world?.id !== world ||
      state.world.generation !== edit.generation
    )
      return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10_000)),
    );
    try {
      const r = await api<Receipt>(`/worlds/${world}/edit`, {
        method: "POST",
        body: JSON.stringify(edit),
      });
      if (
        disposed ||
        run !== epoch ||
        state.world?.generation !== edit.generation
      )
        return;
      if (r.accepted) {
        publish({
          pending: state.pending.map((p) =>
            p.id === edit.operationId
              ? { ...p, receipt: r, parts: r.parts || [] }
              : p,
          ),
          lastTx: r.txid || null,
        });
        try {
          if (r.txid) await scene?.awaitTxId(r.txid, 5000);
        } catch {}
        if (
          disposed ||
          run !== epoch ||
          state.world?.generation !== edit.generation
        )
          return;
        const applied = r.parts?.every((p) =>
          p.deleted
            ? !state.parts.some((x) => x.id === p.id)
            : state.parts.some(
                (x) => x.id === p.id && x.revision >= p.revision,
              ),
        );
        if (applied)
          publish({
            pending: state.pending.filter((p) => p.id !== edit.operationId),
            error: null,
          });
        else
          notice("Saved in Postgres; waiting for the live scene to catch up.");
      } else
        publish({
          pending: state.pending.filter((p) => p.id !== edit.operationId),
          error: r.error || "Edit conflicted",
        });
      return;
    } catch {}
  }
  publish({
    status: "stale",
    error:
      "Could not confirm the edit. Reload to recover the authoritative workshop.",
  });
}
export function selectedConnections(ids: string[]) {
  return state.connections
    .filter((c) => ids.includes(c.a) || ids.includes(c.b))
    .map((c) => ({ id: c.id, revision: c.revision }));
}
export async function newRoom(empty = false) {
  const w = await api<{ slug: string }>("/worlds", {
    method: "POST",
    body: JSON.stringify({
      title: empty ? "A blank canvas" : "My little workshop",
      starter: empty ? "empty" : "rover",
    }),
  });
  location.assign(`/w/${w.slug}`);
}
export async function resetRoom(empty = false) {
  if (!state.world) return;
  await api(`/worlds/${state.world.id}/reset`, {
    method: "POST",
    body: JSON.stringify({
      generation: state.world.generation,
      starter: empty ? "empty" : "rover",
    }),
  });
}
export async function rename(name: string) {
  await api("/profile", {
    method: "POST",
    body: JSON.stringify({ name, color: state.color }),
  });
}

export async function lifecycleRoom(status: "open" | "closed") {
  if (!state.world) return;
  await api(`/worlds/${state.world.id}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ generation: state.world.generation, status }),
  });
}
