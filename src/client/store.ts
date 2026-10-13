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
  AIGenerationProgress,
  AIConversationRow,
} from "../shared/types";
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
let disposed = false,
  epoch = 0,
  renewTimers = new Set<ReturnType<typeof setTimeout>>(),
  heartTimer: ReturnType<typeof setInterval> | undefined,
  sessionTimer: ReturnType<typeof setInterval> | undefined;
let clock = { server: Date.now(), mono: performance.now() };
export const serverNow = () => clock.server + performance.now() - clock.mono;
export const getViewerId = () => viewer;
let rejoining = false;
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
      signal: init.signal || AbortSignal.timeout(20_000),
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
export async function watchGeneration(
  id: string,
  receive: (row: AIGenerationProgress) => void,
) {
  if (!client)
    throw new Error("Wait for the workshop to connect, then try again.");
  const capability = await api<SealedLiveQuery<AIGenerationProgress>>(
    `/ai/generations/${id}/live`,
  );
  const sub = client.subscribe(capability);
  const off = sub.onChange((snapshot) => {
    if (snapshot.data?.[0]) receive(snapshot.data[0]);
  });
  let stopped = false;
  const timer = setInterval(() => {
    void api<SealedLiveQuery<AIGenerationProgress>>(
      `/ai/generations/${id}/live`,
    )
      .then((next) => {
        if (!stopped) return sub.renew(next);
      })
      .catch(() => {});
  }, 40_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    off();
    sub.unsubscribe();
  };
}
export async function watchConversation(
  world: string,
  receive: (rows: readonly AIConversationRow[]) => void,
  reportError: (message: string) => void,
) {
  if (!client)
    throw new Error("Wait for the workshop to connect, then try again.");
  const currentClient = client;
  let capability = await api<SealedLiveQuery<AIConversationRow>>(
    `/worlds/${world}/live/ai`,
  );
  const sub = currentClient.subscribe(capability);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = sub.onChange((snapshot) => {
    if (stopped) return;
    if (snapshot.status === "live") receive(snapshot.data || []);
    else if (snapshot.error) reportError(snapshot.error.message);
  });
  const schedule = (delay: number) => {
    timer = setTimeout(() => void renew(), delay);
  };
  const renew = async () => {
    try {
      const next = await api<SealedLiveQuery<AIConversationRow>>(
        `/worlds/${world}/live/ai`,
      );
      if (stopped) return;
      await sub.renew(next);
      capability = next;
      schedule(Math.max(1000, capability.expiresAt - serverNow() - 12000));
    } catch (e) {
      if (stopped) return;
      if ([401, 403].includes((e as { status?: number }).status || 0)) {
        receive([]);
        reportError((e as Error).message);
        return;
      }
      schedule(1000);
    }
  };
  schedule(Math.max(1000, capability.expiresAt - serverNow() - 12000));
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
    sub.unsubscribe();
  };
}
async function history() {
  if (!state.world) return;
  try {
    publish({ history: await api(`/worlds/${state.world.id}/history`) });
  } catch {}
}
export async function start(slug: string) {
  disposed = false;
  const run = ++epoch,
    active = () => !disposed && run === epoch;
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  presenceFlight = null;
  sequence = 0;
  lastIntent = "";
  intent = { preview: null, selection: [], cursor: null };
  const schedule = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      renewTimers.delete(timer);
      if (active()) callback();
    }, delay);
    renewTimers.add(timer);
  };
  try {
    if (!token) {
      const name = `Builder ${Math.floor(Math.random() * 900 + 100)}`,
        color = COLORS[Math.floor(Math.random() * 6)].hex;
      const session = await api<{ token: string }>("/session", {
        method: "POST",
        body: JSON.stringify({ name, color }),
      });
      token = session.token;
      sessionStorage.setItem("neon-bricks-session", token);
    }
    let joined: any;
    try {
      joined = await api(`/worlds/${slug}/join`, { method: "POST" });
    } catch (e) {
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
      canReset: joined.canReset,
      canBuildAI: joined.canBuildAI === true,
    });
    const url = import.meta.env.VITE_NEON_REALTIME_URL;
    if (!url) throw new Error("Realtime URL is missing. Check .env.local.");
    client = createRealtimeClient({ url });
    const subscribe = async <T>(
      kind: string,
      receive: (data: readonly T[], status: string, error?: string) => void,
    ) => {
      let capability = await api<SealedLiveQuery<T>>(
        `/worlds/${joined.world.id}/live/${kind}`,
      );
      const sub = client!.subscribe(capability);
      sub.onChange((snapshot) => {
        if (active())
          receive(
            snapshot.data || [],
            snapshot.status,
            snapshot.error?.message,
          );
      });
      const renew = async () => {
        try {
          capability = await api(`/worlds/${joined.world.id}/live/${kind}`);
          if (!active()) return;
          await sub.renew(capability);
          scheduleRenewal();
        } catch (e) {
          if (!active()) return;
          if ((e as any).status === 401 || (e as any).status === 403) {
            publish({ status: "error", error: (e as Error).message });
            return;
          }
          // Retry the failed renewal itself, even if sealing succeeded and
          // the replacement capability has a later expiry than the old one.
          schedule(() => void renew(), 1000);
        }
      };
      const scheduleRenewal = () =>
        schedule(
          () => void renew(),
          Math.max(1000, capability.expiresAt - serverNow() - 12_000),
        );
      scheduleRenewal();
      return sub;
    };
    scene = await subscribe<SceneRow>("scene", (rows, status, error) => {
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
        void history();
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
        status,
        ...(error
          ? { error }
          : status === "live" && state.status !== "live"
            ? { error: null }
            : {}),
      });
    });
    await subscribe<Viewer>("presence", (rows) =>
      publish({ viewers: [...rows] }),
    );
    await subscribe<{ undo: string | null; redo: string | null }>(
      "history",
      (rows) => {
        if (rows[0])
          publish({ history: { undo: rows[0].undo, redo: rows[0].redo } });
      },
    );
    await history();
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
  } catch (e) {
    if (active()) publish({ status: "error", error: (e as Error).message });
  }
}
export function stop() {
  disposed = true;
  ++epoch;
  renewTimers.forEach(clearTimeout);
  renewTimers.clear();
  clearInterval(heartTimer);
  clearInterval(sessionTimer);
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  client?.close();
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
    state.status !== "live"
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
    await history();
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
    history: receipt.history || state.history,
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
          history: r.history || state.history,
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
  publish({ name });
}

export async function lifecycleRoom(status: "open" | "closed") {
  if (!state.world) return;
  await api(`/worlds/${state.world.id}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ generation: state.world.generation, status }),
  });
}
