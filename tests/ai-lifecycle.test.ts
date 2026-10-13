import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  receive: (_snapshot: any) => {},
  off: vi.fn(),
  unsubscribe: vi.fn(),
  close: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../src/server/live", () => ({
  trustedRealtime: () => ({ subscribe: mock.subscribe, close: mock.close }),
}));
import { watchCancellation } from "../src/server/ai-lifecycle";
beforeEach(() => {
  vi.clearAllMocks();
  mock.subscribe.mockResolvedValue({
    onChange: (receive: any) => {
      mock.receive = receive;
      return mock.off;
    },
    unsubscribe: mock.unsubscribe,
    getSnapshot: () => ({ status: "connecting", data: [] }),
  });
});
describe("Trusted AI cancellation subscription", () => {
  it("ignores transport failure and aborts only on an authoritative terminal state", async () => {
    const controller = new AbortController();
    const stop = await watchCancellation("fixture", controller);
    for (const status of ["connecting", "stale", "error", "closed"]) {
      mock.receive({ status, data: [{ id: "fixture", status: "cancelled" }] });
      expect(controller.signal.aborted).toBe(false);
    }
    mock.receive({
      status: "live",
      data: [{ id: "fixture", status: "repairing" }],
    });
    expect(controller.signal.aborted).toBe(false);
    mock.receive({
      status: "live",
      data: [{ id: "fixture", status: "cancelled" }],
    });
    expect(controller.signal.aborted).toBe(true);
    stop();
    expect(mock.off).toHaveBeenCalledOnce();
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("ignores callbacks after disposal", async () => {
    const controller = new AbortController();
    const stop = await watchCancellation("fixture", controller);
    stop();
    mock.receive({ status: "live", data: [] });
    expect(controller.signal.aborted).toBe(false);
  });
  it("closes the socket when subscription setup fails", async () => {
    mock.subscribe.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(
      watchCancellation("fixture", new AbortController()),
    ).rejects.toThrow("Unavailable");
    expect(mock.close).toHaveBeenCalledOnce();
  });
});
