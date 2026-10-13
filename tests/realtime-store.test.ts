import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  subscriptions: new Map<string, any>(),
  hangRenewal: false,
  rejectRenewal: false,
}));
vi.mock("@neon/realtime/client", () => ({
  createRealtimeClient: () => ({
    subscribe: (capability: any) => {
      const sub = {
        listener: (_snapshot: any) => {},
        getSnapshot: () => ({ data: [], status: "stale" }),
        onChange: vi.fn((listener: any) => {
          sub.listener = listener;
          return vi.fn();
        }),
        renew: vi.fn(() =>
          mock.rejectRenewal
            ? Promise.reject(new Error("Socket renewal failed"))
            : mock.hangRenewal
              ? new Promise<void>(() => {})
              : Promise.resolve(),
        ),
        awaitTxId: vi.fn(() => Promise.resolve()),
        unsubscribe: vi.fn(),
      };
      mock.subscriptions.set(capability.kind, sub);
      return sub;
    },
    close: vi.fn(),
  }),
}));
let store: typeof import("../src/client/store");
let fetcher: ReturnType<typeof vi.fn>;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const world = {
  id: "world",
  slug: "room",
  title: "Audit fixture",
  generation: 1,
  catalogue: "workshop-1",
  status: "open",
};
const emit = (kind: string, data: any[], status = "live", error?: unknown) =>
  mock.subscriptions.get(kind).listener({ data, status, error });
const calls = (suffix: string) =>
  fetcher.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  vi.resetModules();
  mock.subscriptions.clear();
  mock.hangRenewal = false;
  mock.rejectRenewal = false;
  vi.stubEnv("VITE_NEON_REALTIME_URL", "wss://audit.invalid");
  vi.stubGlobal("sessionStorage", {
    getItem: () => "audit-token",
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/join"))
      return reply({
        world,
        viewer: "viewer",
        guest: "guest",
        name: "Original",
        color: "#289b74",
        canBuildAI: true,
        serverTime: Date.now(),
      });
    if (url.includes("/live/"))
      return reply({
        kind: url.split("/").at(-1),
        queryFingerprint: url,
        expiresAt: Date.now() + 60000,
      });
    if (url.endsWith("/history")) return reply({ undo: null, redo: null });
    return reply({});
  });
  vi.stubGlobal("fetch", fetcher);
  store = await import("../src/client/store");
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Realtime lifecycle regressions", () => {
  it("uses only live history at startup", async () => {
    await store.start("room");
    emit("history", [
      { undo: "new-live-operation", redo: null, generation: 1 },
    ]);
    expect(store.getState().history.undo).toBe("new-live-operation");
    expect(calls("/worlds/world/history")).toBe(0);
  });
  it("keeps fetching capabilities through a long socket outage", async () => {
    await store.start("room");
    const stop = await store.watchConversation("world", vi.fn());
    mock.hangRenewal = true;
    await vi.advanceTimersByTimeAsync(48000);
    expect(calls("/live/scene")).toBe(2);
    expect(calls("/live/ai")).toBe(2);
    await vi.advanceTimersByTimeAsync(120000);
    expect(calls("/live/scene")).toBe(4);
    expect(calls("/live/ai")).toBe(4);
    stop();
  });
  it("clears undo when the authoritative history result is empty", async () => {
    await store.start("room");
    emit("history", [{ undo: "old-operation", redo: null, generation: 1 }]);
    emit("history", []);
    expect(store.getState().history.undo).toBeNull();
  });
  it("a delayed mutation receipt cannot overwrite newer Realtime history", async () => {
    await store.start("room");
    emit("scene", [
      { ...world, kind: "world" },
      {
        kind: "part",
        id: "brick",
        key: "brick-1x1",
        color: "#289b74",
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        revision: 1,
      },
    ]);
    emit("member", [
      {
        id: "guest",
        name: "Original",
        color: "#289b74",
        role: "editor",
        can_reset: true,
      },
    ]);
    let release!: (response: Response) => void;
    const original = fetcher.getMockImplementation()! as (
      ...args: any[]
    ) => Promise<Response>;
    fetcher.mockImplementation((url: string) =>
      url.endsWith("/edit")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : original(url),
    );
    const submitting = store.submit({
      action: "edit",
      changes: [{ id: "brick", expected: 1, color: "#edbc46" }],
    });
    emit("history", [
      { undo: "new-live-operation", redo: null, generation: 1 },
    ]);
    release(
      reply({
        accepted: true,
        generation: 1,
        parts: [],
        txid: "42",
        history: { undo: "older-receipt-operation", redo: null },
      }),
    );
    await submitting;
    expect(store.getState().history.undo).toBe("new-live-operation");
  });
  it("reports a presence failure without declaring the scene unsaved", async () => {
    await store.start("room");
    emit("scene", [{ ...world, kind: "world" }]);
    emit(
      "presence",
      [{ id: "peer", name: "Peer" }],
      "error",
      new Error("Presence failed"),
    );
    expect(store.getState().status).toBe("live");
    expect(store.getState().error).toBeNull();
    expect(store.getState().queries.presence).toEqual({
      status: "error",
      error: "Presence failed",
    });
    emit("presence", [], "live");
    expect(store.getState().queries.presence.error).toBeUndefined();
  });
  it("exposes stale and recovering AI conversation snapshots", async () => {
    await store.start("room");
    const receive = vi.fn();
    const stop = await store.watchConversation("world", receive);
    emit("ai", [{ id: "draft", status: "ready" }]);
    emit(
      "ai",
      [{ id: "draft", status: "ready" }],
      "stale",
      new Error("Disconnected"),
    );
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "stale", error: "Disconnected" }),
    );
    emit("ai", [{ id: "draft", status: "ready" }]);
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "live", error: undefined }),
    );
    stop();
  });
  it("keeps profile and edit permissions live", async () => {
    await store.start("room");
    emit("member", [
      {
        id: "guest",
        role: "viewer",
        can_reset: false,
        name: "Renamed elsewhere",
        color: "#edbc46",
      },
    ]);
    expect(store.getState().name).toBe("Renamed elsewhere");
    expect(store.getState().color).toBe("#edbc46");
    expect(store.getState().role).toBe("viewer");
    expect(store.getState().canBuildAI).toBe(false);
    expect(await store.submit({ action: "edit", changes: [] })).toBe(false);
  });
  it("detaches a denied conversation and ignores its late callbacks", async () => {
    await store.start("room");
    const receive = vi.fn();
    const stop = await store.watchConversation("world", receive);
    emit("ai", [{ id: "draft", status: "ready" }]);
    const original = fetcher.getMockImplementation()! as (
      ...args: any[]
    ) => Promise<Response>;
    fetcher.mockImplementation((url: string) =>
      url.endsWith("/live/ai")
        ? Promise.resolve(reply({ error: "Session expired" }, 401))
        : original(url),
    );
    await vi.advanceTimersByTimeAsync(48000);
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: [],
        status: "error",
        error: "Session expired",
      }),
    );
    expect(mock.subscriptions.get("ai").unsubscribe).toHaveBeenCalledOnce();
    emit("ai", [{ id: "draft", status: "ready" }]);
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: [], status: "error" }),
    );
    stop();
  });
});

it("retries rejected socket renewals and stops all work on disposal", async () => {
  await store.start("room");
  mock.rejectRenewal = true;
  await vi.advanceTimersByTimeAsync(49000);
  expect(calls("/live/scene")).toBe(3);
  store.stop();
  const before = calls("/live/scene");
  await vi.advanceTimersByTimeAsync(120000);
  expect(calls("/live/scene")).toBe(before);
});
it("ignores a capability fetched after disposal", async () => {
  await store.start("room");
  let release!: (response: Response) => void;
  const original = fetcher.getMockImplementation()! as (
    ...args: any[]
  ) => Promise<Response>;
  fetcher.mockImplementation((url: string) =>
    url.endsWith("/live/scene")
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : original(url),
  );
  await vi.advanceTimersByTimeAsync(48000);
  store.stop();
  release(
    reply({
      kind: "scene",
      queryFingerprint: "/api/worlds/world/live/scene",
      expiresAt: Date.now() + 60000,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(mock.subscriptions.get("scene").renew).not.toHaveBeenCalled();
});
it("uses the server clock when the browser clock jumps", async () => {
  await store.start("room");
  vi.setSystemTime(new Date("2030-01-01"));
  // serverNow follows a monotonic clock rather than the shifted wall clock.
  expect(store.serverNow()).toBeLessThan(new Date("2030-01-01").getTime());
});
it("reconciles history when its new generation arrives before the scene", async () => {
  await store.start("room");
  emit("history", [{ undo: "new-generation", redo: null, generation: 2 }]);
  expect(store.getState().history.undo).toBeNull();
  emit("scene", [{ ...world, generation: 2, kind: "world" }]);
  expect(store.getState().history.undo).toBe("new-generation");
});

it("stops a terminal SDK query failure instead of repeatedly renewing it", async () => {
  await store.start("room");
  const receive = vi.fn();
  await store.watchConversation("world", receive);
  emit(
    "ai",
    [{ id: "draft", status: "ready" }],
    "error",
    Object.assign(new Error("Query rejected"), { retryable: false }),
  );
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: [],
      status: "error",
      error: "Query rejected",
    }),
  );
  expect(mock.subscriptions.get("ai").unsubscribe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(calls("/live/ai")).toBe(1);
});

it("a delayed rename response cannot replace a newer live profile", async () => {
  await store.start("room");
  let release!: (response: Response) => void;
  const original = fetcher.getMockImplementation()! as (
    ...args: any[]
  ) => Promise<Response>;
  fetcher.mockImplementation((url: string) =>
    url.endsWith("/profile")
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : original(url),
  );
  const rename = store.rename("Earlier rename");
  emit("member", [
    {
      id: "guest",
      name: "Latest rename",
      color: "#289b74",
      role: "editor",
      can_reset: true,
    },
  ]);
  release(reply({ ok: true }));
  await rename;
  expect(store.getState().name).toBe("Latest rename");
});

it("an obsolete startup cannot replace the new scene transaction tracker", async () => {
  let release!: (response: Response) => void;
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const original = fetcher.getMockImplementation()! as (
    ...args: any[]
  ) => Promise<Response>;
  let first = true;
  fetcher.mockImplementation((url: string) => {
    if (url.endsWith("/live/scene") && first) {
      first = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
        reached();
      });
    }
    if (url.endsWith("/edit"))
      return Promise.resolve(
        reply({ accepted: true, generation: 1, parts: [], txid: "42" }),
      );
    return original(url);
  });
  const old = store.start("room");
  await requested;
  await store.start("room");
  emit("scene", [{ ...world, kind: "world" }]);
  emit("member", [
    {
      id: "guest",
      name: "Builder",
      color: "#289b74",
      role: "editor",
      can_reset: true,
    },
  ]);
  const current = mock.subscriptions.get("scene");
  release(
    reply({
      kind: "scene",
      queryFingerprint: "/api/worlds/world/live/scene",
      expiresAt: Date.now() + 60000,
    }),
  );
  await old;
  expect(await store.submit({ action: "edit", changes: [] })).toBe(true);
  expect(current.awaitTxId).toHaveBeenCalledWith("42", 5000);
});
