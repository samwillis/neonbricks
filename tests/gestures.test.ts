import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { installGestures, type GestureProps } from "../src/client/gestures";
import type { Position } from "../src/shared/types";

class Canvas extends EventTarget {
  style = { cursor: "" };
  captured = new Set<number>();
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
    this.dispatchEvent(event("lostpointercapture", { pointerId: id }));
  }
}
function event(type: string, values = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    button: 0,
    clientX: 50,
    clientY: 50,
    shiftKey: false,
    altKey: false,
    ...values,
  });
}
function setup() {
  const canvas = new Canvas(),
    keys = new EventTarget(),
    orbit = { enabled: true };
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 8, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
  mesh.userData.partAt = () => ({ id: "brick" });
  scene.add(mesh);
  scene.updateMatrixWorld();
  let preview: Position | null = null;
  const commits: Position[] = [];
  const props: GestureProps = {
    selectMode: true,
    canMove: true,
    presentation: false,
    selected: ["brick"],
    onGrab: vi.fn(() => true),
    onDrag: vi.fn((delta) => {
      preview = delta;
    }),
    onDrop: vi.fn(() => {
      if (preview) commits.push(preview);
      preview = null;
    }),
    onCancelDrag: vi.fn(() => {
      preview = null;
    }),
  };
  const gestures = installGestures(
    canvas as unknown as HTMLCanvasElement,
    camera,
    scene,
    orbit,
    () => props,
    keys as unknown as Window,
  );
  return { canvas, keys, orbit, props, commits, gestures, scene, camera, mesh };
}

describe("pointer gesture lifecycle", () => {
  it("reports the target under a held drag with its instance-transformed normal", () => {
    const s = setup();
    const target = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial(),
      1,
    );
    const transform = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
    transform.setPosition(3, 0, 0);
    target.setMatrixAt(0, transform);
    target.userData.partAt = () => ({ id: "target" });
    s.scene.add(target);
    s.scene.updateMatrixWorld();
    const screen = new THREE.Vector3(3, 0, 0).project(s.camera);
    s.canvas.dispatchEvent(event("pointerdown"));
    s.canvas.dispatchEvent(
      event("pointermove", {
        clientX: (screen.x + 1) * 50,
        clientY: (1 - screen.y) * 50,
      }),
    );
    const hover = vi.mocked(s.props.onDrag).mock.calls.at(-1)?.[1];
    expect(hover?.surface.part?.id).toBe("target");
    expect(hover?.surface.normal.x).toBeCloseTo(-1);
    expect(hover?.surface.normal.z).toBeCloseTo(0);
    expect(hover?.surface.point.x).toBeCloseTo(18);
    s.gestures.dispose();
  });

  it("keeps axis drags constrained without surface attachment snapping", () => {
    const s = setup();
    s.mesh.userData.moveAxis = "x";
    s.canvas.dispatchEvent(event("pointerdown"));
    s.canvas.dispatchEvent(event("pointermove", { clientX: 80, clientY: 70 }));
    const [delta, hover] = vi.mocked(s.props.onDrag).mock.calls.at(-1)!;
    expect(delta.x).not.toBe(0);
    expect(delta.y).toBe(0);
    expect(delta.z).toBe(0);
    expect(hover).toBeUndefined();
    s.gestures.dispose();
  });

  it("selects without moving on a click or small pointer jitter", () => {
    const s = setup();
    s.canvas.dispatchEvent(event("pointerdown"));
    expect(s.orbit.enabled).toBe(false);
    s.canvas.dispatchEvent(event("pointermove", { clientX: 52 }));
    s.canvas.dispatchEvent(event("pointerup", { clientX: 52 }));
    expect(s.props.onGrab).toHaveBeenCalledOnce();
    expect(s.props.onDrag).not.toHaveBeenCalled();
    expect(s.commits).toEqual([]);
    expect(s.orbit.enabled).toBe(true);
    expect(s.canvas.captured.size).toBe(0);
    s.gestures.dispose();
  });

  it("cancels a held drag with Escape and suppresses the subsequent selection click", () => {
    const s = setup(),
      click = vi.fn();
    s.canvas.addEventListener("click", click);
    s.canvas.dispatchEvent(event("pointerdown"));
    s.canvas.dispatchEvent(event("pointermove", { clientX: 80 }));
    expect(s.props.onDrag).toHaveBeenCalledOnce();
    const escape = event("keydown", { key: "Escape" });
    s.keys.dispatchEvent(escape);
    s.canvas.dispatchEvent(event("pointerup", { clientX: 80 }));
    s.canvas.dispatchEvent(event("click"));
    expect(escape.defaultPrevented).toBe(true);
    expect(s.props.onDrop).not.toHaveBeenCalled();
    expect(s.commits).toEqual([]);
    expect(click).not.toHaveBeenCalled();
    expect(s.orbit.enabled).toBe(true);
    expect(s.canvas.captured.size).toBe(0);
    s.gestures.dispose();
  });

  it("commits once on release outside the canvas, including the final coordinates", () => {
    const s = setup();
    s.canvas.dispatchEvent(event("pointerdown"));
    s.canvas.dispatchEvent(event("pointermove", { clientX: 80 }));
    s.canvas.dispatchEvent(event("pointerup", { clientX: 150 }));
    s.canvas.dispatchEvent(event("pointerup", { clientX: 150 }));
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].x).toBeGreaterThan(0);
    expect(s.commits[0].y).toBe(0);
    expect(s.props.onDrop).toHaveBeenCalledOnce();
    expect(s.props.onCancelDrag).not.toHaveBeenCalled();
    expect(s.orbit.enabled).toBe(true);
    s.gestures.dispose();
  });

  it.each([
    "pointercancel",
    "lostpointercapture",
    "blur",
    "lifecycle",
    "dispose",
  ])("abandons a held preview on %s without committing", (reason) => {
    const s = setup();
    s.canvas.dispatchEvent(event("pointerdown"));
    s.canvas.dispatchEvent(event("pointermove", { clientX: 80 }));
    if (reason === "blur") s.keys.dispatchEvent(event("blur"));
    else if (reason === "lifecycle") s.gestures.cancel();
    else if (reason === "dispose") s.gestures.dispose();
    else s.canvas.dispatchEvent(event(reason));
    s.canvas.dispatchEvent(event("pointerup", { clientX: 80 }));
    expect(s.commits).toEqual([]);
    expect(s.props.onCancelDrag).toHaveBeenCalledOnce();
    expect(s.orbit.enabled).toBe(true);
    expect(s.canvas.captured.size).toBe(0);
    s.gestures.dispose();
  });
});
