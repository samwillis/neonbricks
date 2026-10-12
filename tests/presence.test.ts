import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@neon/realtime/client", () => ({
  createRealtimeClient: () => ({
    subscribe: () => ({ onChange: vi.fn(), renew: vi.fn() }),
    close: vi.fn(),
  }),
}));

type Store = typeof import("../src/client/store");
let store: Store;
let fetcher: ReturnType<typeof vi.fn>;
let payloads: Array<any>;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  vi.resetModules();
  vi.stubEnv("VITE_NEON_REALTIME_URL", "wss://test.example");
  vi.stubGlobal("sessionStorage", {
    getItem: () => "test-token",
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
  payloads = [];
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/join"))
      return reply({
        viewer: "viewer",
        world: { id: "world", slug: "room", generation: 1, status: "open" },
      });
    if (url.includes("/live/")) return reply({ expiresAt: Date.now() + 60000 });
    if (url.endsWith("/presence"))
      payloads.push(JSON.parse(init.body as string));
    return reply({});
  });
  vi.stubGlobal("fetch", fetcher);
  store = await import("../src/client/store");
  await store.start("room");
  await vi.advanceTimersByTimeAsync(200);
  payloads.length = 0;
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("coalesced viewer presence", () => {
  it("keeps only the latest cursor behind an in-flight request and preserves selection", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetcher.mockImplementationOnce(async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return pending;
    });
    store.setCursor({ x: 1, y: 2, z: 3 });
    await vi.advanceTimersByTimeAsync(200);
    store.setCursor({ x: 4, y: 5, z: 6 });
    store.setCursor({ x: 7, y: 8, z: 9 });
    store.setIntent(null, ["selected-brick"]);
    await store.sendPresence(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(payloads).toHaveLength(1);
    release(reply({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({
      cursor: { x: 7, y: 8, z: 9 },
      selection: ["selected-brick"],
    });
    expect(payloads[1].sequence).toBeGreaterThan(payloads[0].sequence);
    store.setCursor({ x: 10, y: 11, z: 12 });
    await store.sendPresence(true);
    expect(payloads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(payloads).toHaveLength(3);
  });
  it("paces quick requests from their send time rather than adding a delay after each response", async () => {
    store.setCursor({ x: 1, y: 2, z: 3 });
    await vi.advanceTimersByTimeAsync(200);
    store.setCursor({ x: 4, y: 5, z: 6 });
    await vi.advanceTimersByTimeAsync(199);
    expect(payloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(payloads).toHaveLength(2);
  });
  it("refreshes a stationary cursor, then sends its departure without replaying it", async () => {
    store.setCursor({ x: 1, y: 2, z: 3 });
    await vi.advanceTimersByTimeAsync(200);
    await store.sendPresence(true);
    expect(payloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await store.sendPresence(true);
    expect(payloads).toHaveLength(2);
    store.setCursor(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(payloads[2].cursor).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await store.sendPresence(true);
    expect(payloads).toHaveLength(3);
  });
  it("retries the latest sample after a transient failure", async () => {
    fetcher.mockImplementationOnce(async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return reply({ error: "Temporary failure" }, 503);
    });
    store.setCursor({ x: 1, y: 2, z: 3 });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(payloads).toHaveLength(2);
    expect(payloads[1].cursor).toEqual(payloads[0].cursor);
  });
  it("does not send queued positions after leaving", async () => {
    store.setCursor({ x: 1, y: 2, z: 3 });
    store.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(payloads).toHaveLength(0);
  });
  it("does not rejoin when an old in-flight request expires after leaving", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetcher.mockImplementationOnce(() => pending);
    store.setCursor({ x: 1, y: 2, z: 3 });
    await vi.advanceTimersByTimeAsync(200);
    store.stop();
    fetcher.mockClear();
    release(reply({ error: "Viewer expired" }, 410));
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
