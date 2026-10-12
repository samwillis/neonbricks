import * as THREE from "three";
import { UNIT, type Position } from "../shared/types";

export const CURSOR_TTL = 3000;

// Track real scene surfaces, independently of placement snapping and drag handles.
export function installCursorTracking(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  scene: THREE.Scene,
  onCursor: (cursor: Position | null) => void,
  keys: Window = window,
  page: Document = document,
) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let location: { x: number; y: number } | null = null;
  let dirty = true;
  const cameraPose = new THREE.Matrix4();
  const projection = new THREE.Matrix4();
  let viewport = "";
  let signature = "";
  const emit = (point: Position | null) => {
    const next = JSON.stringify(point);
    if (next === signature) return;
    signature = next;
    onCursor(point);
  };
  const clear = () => {
    location = null;
    emit(null);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType === "touch") return clear();
    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    )
      return clear();
    location = { x: e.clientX, y: e.clientY };
    dirty = true;
  };
  const visibility = () => {
    if (page.visibilityState !== "visible") clear();
  };
  canvas.addEventListener("pointermove", move, true);
  canvas.addEventListener("pointerdown", move, true);
  canvas.addEventListener("pointerleave", clear);
  canvas.addEventListener("pointercancel", clear);
  keys.addEventListener("blur", clear);
  page.addEventListener("visibilitychange", visibility);
  return {
    clear,
    invalidate() {
      dirty = true;
    },
    update() {
      if (!location) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return clear();
      const nextViewport = `${rect.left}/${rect.top}/${rect.width}/${rect.height}`;
      if (
        !dirty &&
        viewport === nextViewport &&
        cameraPose.equals(camera.matrixWorld) &&
        projection.equals((camera as THREE.PerspectiveCamera).projectionMatrix)
      )
        return;
      dirty = false;
      viewport = nextViewport;
      cameraPose.copy(camera.matrixWorld);
      projection.copy((camera as THREE.PerspectiveCamera).projectionMatrix);
      pointer.set(
        ((location.x - rect.left) / rect.width) * 2 - 1,
        1 - ((location.y - rect.top) / rect.height) * 2,
      );
      raycaster.setFromCamera(pointer, camera);
      // Restrict picking to bricks and the board; ghosts, handles and cursors
      // must never steal the point being shared.
      const surfaces: THREE.Object3D[] = [];
      scene.traverseVisible((object) => {
        if (object.userData.partAt || object.userData.cursorSurface)
          surfaces.push(object);
      });
      const hit = raycaster
        .intersectObjects(surfaces, false)
        .find(
          (hit) =>
            hit.object.userData.cursorSurface ||
            hit.object.userData.partAt?.(hit.instanceId ?? -1),
        );
      emit(
        hit
          ? {
              x: Math.round(hit.point.x * UNIT * 100) / 100 || 0,
              y: Math.round(hit.point.y * UNIT * 100) / 100 || 0,
              z: Math.round(hit.point.z * UNIT * 100) / 100 || 0,
            }
          : null,
      );
    },
    dispose() {
      clear();
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerdown", move, true);
      canvas.removeEventListener("pointerleave", clear);
      canvas.removeEventListener("pointercancel", clear);
      keys.removeEventListener("blur", clear);
      page.removeEventListener("visibilitychange", visibility);
    },
  };
}
