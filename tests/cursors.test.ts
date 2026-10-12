import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { installCursorTracking } from "../src/client/cursors";

function setup() {
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    }),
  });
  const keys = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 8, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(32, 32));
  board.rotation.x = -Math.PI / 2;
  board.userData.cursorSurface = true;
  const brick = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2, 1, 2),
    new THREE.MeshBasicMaterial(),
    1,
  );
  brick.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0.5, 0));
  brick.userData.partAt = () => ({ id: "brick" });
  // This closer object represents a handle or a collaborator's preview.
  const overlay = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
  overlay.position.y = 2;
  scene.add(board, brick, overlay);
  scene.updateMatrixWorld();
  const onCursor = vi.fn();
  const tracking = installCursorTracking(
    canvas as unknown as HTMLCanvasElement,
    camera,
    scene,
    onCursor,
    keys as unknown as Window,
    page as unknown as Document,
  );
  const move = (x = 50, y = 50, pointerType = "mouse") => {
    canvas.dispatchEvent(
      Object.assign(new Event("pointermove"), {
        clientX: x,
        clientY: y,
        pointerType,
      }),
    );
    tracking.update();
  };
  return { canvas, keys, page, camera, brick, board, onCursor, tracking, move };
}

describe("collaborative surface cursors", () => {
  it("picks the frontmost real brick in database units, ignoring overlays", () => {
    const s = setup();
    s.move();
    expect(s.onCursor).toHaveBeenLastCalledWith({ x: 0, y: 4.8, z: 6 });
    s.move();
    expect(s.onCursor).toHaveBeenCalledTimes(1);
    s.tracking.dispose();
  });
  it("picks the board and clears when the ray misses or a captured pointer leaves", () => {
    const s = setup();
    s.brick.visible = false;
    s.move();
    expect(s.onCursor).toHaveBeenLastCalledWith({ x: 0, y: 0, z: 0 });
    s.board.visible = false;
    s.tracking.invalidate();
    s.tracking.update();
    expect(s.onCursor).toHaveBeenLastCalledWith(null);
    s.board.visible = true;
    s.move();
    s.move(101, 50);
    expect(s.onCursor).toHaveBeenLastCalledWith(null);
    s.tracking.dispose();
  });
  it("reprojects a stationary pointer when the camera moves", () => {
    const s = setup();
    s.move();
    s.camera.position.x = 8;
    s.camera.lookAt(0, 0, 0);
    s.camera.updateMatrixWorld();
    s.tracking.update();
    expect(s.onCursor.mock.calls.at(-1)?.[0]).not.toEqual(
      s.onCursor.mock.calls[0][0],
    );
    s.tracking.dispose();
  });
  it.each(["pointerleave", "pointercancel", "blur", "hidden", "dispose"])(
    "clears on %s without reviving the old pointer",
    (reason) => {
      const s = setup();
      s.move();
      if (reason === "hidden") {
        s.page.visibilityState = "hidden";
        s.page.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "dispose") s.tracking.dispose();
      else
        (reason === "blur" ? s.keys : s.canvas).dispatchEvent(
          new Event(reason),
        );
      expect(s.onCursor).toHaveBeenLastCalledWith(null);
      const count = s.onCursor.mock.calls.length;
      s.tracking.update();
      expect(s.onCursor).toHaveBeenCalledTimes(count);
      s.tracking.dispose();
    },
  );
  it("does not share a persistent mouse cursor for touch input", () => {
    const s = setup();
    s.move();
    s.move(50, 50, "touch");
    expect(s.onCursor).toHaveBeenLastCalledWith(null);
    s.tracking.dispose();
  });
});
