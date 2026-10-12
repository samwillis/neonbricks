import * as THREE from "three";
import type { Part, Position } from "../shared/types";
import { snapMovement, type MoveAxis } from "./movement";
import type { DragSurface } from "./snapping";

export type GestureProps = {
  selectMode: boolean;
  canMove: boolean;
  presentation: boolean;
  selected: string[];
  onGrab: (part?: Part, shift?: boolean) => boolean;
  onDrag: (delta: Position, hover?: DragSurface) => void;
  onDrop: () => void;
  onCancelDrag: () => void;
};

// Capture runs before OrbitControls' native pointer listener. Pointer capture
// keeps a drag alive outside the canvas and gives cancellation one cleanup path.
export function installGestures(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  scene: THREE.Scene,
  orbit: { enabled: boolean } | null,
  getProps: () => GestureProps,
  keys: Window = window,
) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let blockClick = false;
  let gesture: {
    id: number;
    x: number;
    y: number;
    movable: boolean;
    dragging: boolean;
    axis?: MoveAxis;
    plane: THREE.Plane;
    start: THREE.Vector3;
    ids: string[];
  } | null = null;
  const ray = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  };
  const finish = (cancel = false) => {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    if (canvas.hasPointerCapture(previous.id))
      canvas.releasePointerCapture(previous.id);
    if (orbit) orbit.enabled = true;
    canvas.style.cursor = "";
    if (cancel) getProps().onCancelDrag();
    else getProps().onDrop();
  };
  const down = (e: PointerEvent) => {
    if (gesture || e.button !== 0) return;
    blockClick = false;
    const props = getProps();
    if (props.presentation) return;
    ray(e);
    const hits = raycaster.intersectObjects(scene.children, true);
    const hit =
      hits.find(
        (h) => h.object.userData.moveAxis && h.object.parent?.visible,
      ) || hits.find((h) => h.object.userData.partAt?.(h.instanceId ?? -1));
    if (!hit) return;
    const axis = hit.object.userData.moveAxis as MoveAxis | undefined;
    const part = hit.object.userData.partAt?.(hit.instanceId ?? -1) as
      Part | undefined;
    if (axis && (!props.selectMode || !props.canMove)) return;
    blockClick = props.selectMode;
    const movable = props.selectMode && props.onGrab(part, e.shiftKey);
    const normal = new THREE.Vector3(0, 1, 0);
    if (axis) {
      camera.getWorldDirection(normal);
      normal[axis] = 0;
      if (normal.lengthSq() < 0.001) return;
      normal.normalize();
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      normal,
      hit.point,
    );
    const start = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!start) return;
    gesture = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      axis,
      movable,
      plane,
      start,
      dragging: false,
      ids:
        part && !props.selected.includes(part.id)
          ? [part.id]
          : [...props.selected],
    };
    if (orbit) orbit.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!gesture || gesture.id !== e.pointerId) return;
    if (!gesture.movable) return;
    e.stopImmediatePropagation();
    if (
      !gesture.dragging &&
      Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 5
    )
      return;
    const point = ray(e).intersectPlane(gesture.plane, new THREE.Vector3());
    if (!point) return;
    gesture.dragging = true;
    canvas.style.cursor = "grabbing";
    const delta = point.sub(gesture.start).multiplyScalar(6);
    let hover: DragSurface | undefined;
    if (!gesture.axis) {
      const hit = raycaster.intersectObjects(scene.children, true).find((h) => {
        const part = h.object.userData.partAt?.(h.instanceId ?? -1) as
          Part | undefined;
        return part && !gesture!.ids.includes(part.id);
      });
      const part = hit?.object.userData.partAt?.(hit.instanceId ?? -1) as
        Part | undefined;
      if (hit && part && hit.face) {
        const matrix = hit.object.matrixWorld.clone();
        if (
          hit.object instanceof THREE.InstancedMesh &&
          hit.instanceId !== undefined
        ) {
          const instance = new THREE.Matrix4();
          hit.object.getMatrixAt(hit.instanceId, instance);
          matrix.multiply(instance);
        }
        const normal = hit.face.normal
          .clone()
          .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(matrix));
        const surfaceDelta = hit.point
          .clone()
          .sub(gesture.start)
          .multiplyScalar(6);
        hover = {
          surface: {
            part,
            point: {
              x: hit.point.x * 6,
              y: hit.point.y * 6,
              z: hit.point.z * 6,
            },
            normal: { x: normal.x, y: normal.y, z: normal.z },
          },
          delta: { x: surfaceDelta.x, y: surfaceDelta.y, z: surfaceDelta.z },
          fine: e.altKey,
        };
      }
    }
    getProps().onDrag(snapMovement(delta, gesture.axis, e.altKey), hover);
  };
  const up = (e: PointerEvent) => {
    if (gesture?.id !== e.pointerId) return;
    // Use the final release coordinates even if no last pointermove arrived.
    move(e);
    finish();
  };
  const cancelled = (e: PointerEvent) => {
    if (gesture?.id === e.pointerId) finish(true);
  };
  const click = (e: MouseEvent) => {
    if (blockClick) {
      e.stopImmediatePropagation();
      blockClick = false;
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && gesture) {
      if (getProps().selectMode) e.preventDefault();
      finish(true);
    }
  };
  const blur = () => finish(true);
  canvas.addEventListener("pointerdown", down, true);
  canvas.addEventListener("pointermove", move, true);
  canvas.addEventListener("pointerup", up, true);
  canvas.addEventListener("pointercancel", cancelled, true);
  canvas.addEventListener("lostpointercapture", cancelled);
  canvas.addEventListener("click", click, true);
  keys.addEventListener("keydown", key, true);
  keys.addEventListener("blur", blur);
  const dispose = () => {
    finish(true);
    canvas.removeEventListener("pointerdown", down, true);
    canvas.removeEventListener("pointermove", move, true);
    canvas.removeEventListener("pointerup", up, true);
    canvas.removeEventListener("pointercancel", cancelled, true);
    canvas.removeEventListener("lostpointercapture", cancelled);
    canvas.removeEventListener("click", click, true);
    keys.removeEventListener("keydown", key, true);
    keys.removeEventListener("blur", blur);
  };

  return { cancel: () => finish(true), dispose };
}
