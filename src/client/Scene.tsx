import { useEffect, useMemo, useRef } from "react";
import {
  Canvas,
  type ThreeEvent,
  useThree,
  useFrame,
} from "@react-three/fiber";
import { OrbitControls, ContactShadows, Edges, Html } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitImpl } from "three-stdlib";
import { CATALOGUE, BY_KEY } from "../shared/catalogue";
import type { Part, Preview, Viewer } from "../shared/types";
import { dimensions, bounds as boundsForHandles } from "../shared/geometry";
import { model } from "./shapes";
import type { Position } from "../shared/types";
import { installGestures } from "./gestures";
import type { DragSurface } from "./snapping";
import { installCursorTracking } from "./cursors";
export type FrameMetrics = {
  p95: number;
  fps: number;
  calls: number;
  triangles: number;
  samples: number;
};
type Props = {
  theme: "light" | "dark";
  parts: Part[];
  selected: string[];
  ghosts: Preview[];
  valid: boolean;
  viewers: Viewer[];
  guest: string;
  generation: number;
  grid: boolean;
  quality: boolean;
  cameraMode: string;
  presentation: boolean;
  selectMode: boolean;
  canMove: boolean;
  dragging: boolean;
  onGrab: (part?: Part, shift?: boolean) => boolean;
  onDrag: (delta: Position, hover?: DragSurface) => void;
  onDrop: () => void;
  onCancelDrag: () => void;
  onMetrics?: (m: FrameMetrics) => void;
  onCursor: (point: Position | null) => void;
  onHover: (
    point: THREE.Vector3,
    normal: THREE.Vector3 | undefined,
    part?: Part,
  ) => void;
  onClick: (p?: Part, shift?: boolean) => void;
};
const temp = new THREE.Object3D(),
  color = new THREE.Color();
function Instances({
  partKey,
  parts,
  selected,
  onHover,
  onClick,
}: {
  partKey: string;
  parts: Part[];
  selected: string[];
  onHover: Props["onHover"];
  onClick: Props["onClick"];
}) {
  const def = BY_KEY[partKey],
    g = useMemo(() => model(def), [def]);
  const body = useRef<THREE.InstancedMesh>(null),
    detail = useRef<THREE.InstancedMesh>(null);
  const slots = useRef(new Map<string, number>()),
    bySlot = useRef(new Map<number, Part>()),
    signatures = useRef(new Map<string, string>());
  useEffect(() => {
    if (!body.current) return;
    const live = new Set(parts.map((p) => p.id));
    for (const [id, i] of slots.current)
      if (!live.has(id)) {
        temp.position.set(0, -100, 0);
        temp.scale.setScalar(0);
        temp.updateMatrix();
        body.current.setMatrixAt(i, temp.matrix);
        detail.current?.setMatrixAt(i, temp.matrix);
        slots.current.delete(id);
        bySlot.current.delete(i);
        signatures.current.delete(id);
      }
    for (const p of parts) {
      let i = slots.current.get(p.id);
      if (i === undefined) {
        i = 0;
        while (bySlot.current.has(i)) i++;
        if (i >= 4096) continue;
        slots.current.set(p.id, i);
      }
      bySlot.current.set(i, p);
      const signature = `${p.revision}/${p.position.x}/${p.position.y}/${p.position.z}/${p.rotation}/${p.color}/${selected.includes(p.id)}`;
      if (signatures.current.get(p.id) === signature) continue;
      signatures.current.set(p.id, signature);
      const d = BY_KEY[p.key],
        a = (p.rotation * Math.PI) / 2;
      temp.scale.setScalar(1);
      temp.rotation.set(0, -a, 0);
      temp.position.set(
        p.position.x / 6 +
          (p.rotation === 1 ? d.d : p.rotation === 2 ? d.w : 0),
        p.position.y / 6,
        p.position.z / 6 +
          (p.rotation === 2 ? d.d : p.rotation === 3 ? d.w : 0),
      );
      temp.updateMatrix();
      body.current.setMatrixAt(i, temp.matrix);
      detail.current?.setMatrixAt(i, temp.matrix);
      color.set(def.shape === "wheel" ? "#343b3a" : p.color);
      if (selected.includes(p.id)) color.lerp(new THREE.Color("#ffffff"), 0.25);
      body.current.setColorAt(i, color);
      detail.current?.setColorAt(
        i,
        new THREE.Color(
          def.shape === "wheel" ? "#b4b9b0" : p.color,
        ).multiplyScalar(0.85),
      );
    }
    const count = Math.max(0, ...bySlot.current.keys()) + 1;
    body.current.count = parts.length ? count : 0;
    body.current.instanceMatrix.needsUpdate = true;
    if (body.current.instanceColor)
      body.current.instanceColor.needsUpdate = true;
    body.current.computeBoundingSphere();
    if (detail.current) {
      detail.current.count = body.current.count;
      detail.current.instanceMatrix.needsUpdate = true;
      if (detail.current.instanceColor)
        detail.current.instanceColor.needsUpdate = true;
      detail.current.computeBoundingSphere();
    }
  }, [parts, selected, def]);
  const hover = (e: ThreeEvent<PointerEvent>) => {
    if (e.buttons) return;
    e.stopPropagation();
    const p = bySlot.current.get(e.instanceId ?? -1);
    const n = e.face?.normal.clone();
    if (n && p)
      n.applyAxisAngle(new THREE.Vector3(0, 1, 0), (-p.rotation * Math.PI) / 2);
    onHover(e.point, n, p);
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return;
    e.stopPropagation();
    onClick(bySlot.current.get(e.instanceId ?? -1), e.shiftKey);
  };
  const pickData = { partAt: (i: number) => bySlot.current.get(i) };
  return (
    <group>
      <instancedMesh
        ref={body}
        args={[g.body, undefined, 4096]}
        castShadow
        receiveShadow
        onPointerMove={hover}
        onClick={click}
        dispose={null}
        userData={pickData}
      >
        <meshStandardMaterial roughness={0.31} metalness={0.02} />
      </instancedMesh>
      {g.detail && (
        <instancedMesh
          ref={detail}
          args={[g.detail, undefined, 4096]}
          castShadow
          receiveShadow
          onPointerMove={hover}
          onClick={click}
          dispose={null}
          userData={pickData}
        >
          <meshStandardMaterial roughness={0.4} metalness={0.16} />
        </instancedMesh>
      )}
    </group>
  );
}
function Piece({
  part,
  opacity = 1,
  tint,
}: {
  part: Preview;
  opacity?: number;
  tint?: string;
}) {
  const d = BY_KEY[part.key];
  if (!d) return null;
  const g = model(d),
    r = part.rotation;
  return (
    <group
      position={[
        part.position.x / 6 + (r === 1 ? d.d : r === 2 ? d.w : 0),
        part.position.y / 6,
        part.position.z / 6 + (r === 2 ? d.d : r === 3 ? d.w : 0),
      ]}
      rotation={[0, (-r * Math.PI) / 2, 0]}
    >
      <mesh geometry={g.body} dispose={null} raycast={() => {}}>
        <meshStandardMaterial
          color={tint || part.color}
          transparent
          opacity={opacity}
          roughness={0.3}
          depthWrite={opacity === 1}
        />
      </mesh>
      {g.detail && (
        <mesh geometry={g.detail} dispose={null} raycast={() => {}}>
          <meshStandardMaterial
            color={tint || part.color}
            transparent
            opacity={opacity}
            roughness={0.5}
            depthWrite={opacity === 1}
          />
        </mesh>
      )}
    </group>
  );
}
function Camera({ mode }: { mode: string }) {
  const { camera } = useThree(),
    controls = useRef<OrbitImpl>(null);
  useEffect(() => {
    const poses: Record<string, number[]> = {
      iso: [22, 22, 27],
      top: [0, 34, 0.001],
      front: [0, 11, 32],
      side: [32, 11, 0],
    };
    const p = poses[mode.split(":")[0]] || poses.iso;
    camera.position.set(p[0], p[1], p[2]);
    controls.current?.target.set(0, 1, 0);
    controls.current?.update();
  }, [mode, camera]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      minDistance={5}
      maxDistance={65}
      maxPolarAngle={Math.PI / 2 - 0.015}
      target={[0, 1, 0]}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
    />
  );
}

// Capture runs before OrbitControls' native pointer listener, so a brick never
// starts a camera gesture. Native pointer capture also covers release off-board.
function Gestures(p: Props) {
  const { gl, camera, scene, controls } = useThree();
  const latest = useRef(p);
  const abort = useRef<() => void>(() => {});
  const cursor = useRef<ReturnType<typeof installCursorTracking> | null>(null);
  const lastCursorFrame = useRef(0);
  latest.current = p;
  useFrame(({ clock }) => {
    if (
      latest.current.presentation ||
      clock.elapsedTime - lastCursorFrame.current < 0.1
    )
      return;
    lastCursorFrame.current = clock.elapsedTime;
    cursor.current?.update();
  });
  useEffect(() => {
    // Register first, before a brick drag stops native pointer propagation.
    const tracking = installCursorTracking(
      gl.domElement,
      camera,
      scene,
      (point) =>
        latest.current.onCursor(latest.current.presentation ? null : point),
    );
    cursor.current = tracking;
    const gestures = installGestures(
      gl.domElement,
      camera,
      scene,
      controls as OrbitImpl | null,
      () => latest.current,
    );
    abort.current = gestures.cancel;
    return () => {
      tracking.dispose();
      cursor.current = null;
      gestures.dispose();
    };
  }, [gl, camera, scene, controls]);
  useEffect(() => {
    if (!p.canMove || p.presentation || !p.selectMode) abort.current();
  }, [p.canMove, p.presentation, p.selectMode]);
  useEffect(() => {
    abort.current();
  }, [p.generation, p.cameraMode]);
  useEffect(() => {
    cursor.current?.clear();
  }, [p.generation, p.presentation]);
  useEffect(() => {
    cursor.current?.invalidate();
  }, [p.parts]);
  return null;
}

function CollaboratorCursor({
  viewer,
}: {
  viewer: Viewer & { cursor: Position };
}) {
  const root = useRef<THREE.Group>(null);
  const target = useMemo(
    () =>
      new THREE.Vector3(
        viewer.cursor.x / 6,
        viewer.cursor.y / 6,
        viewer.cursor.z / 6,
      ),
    [viewer.cursor.x, viewer.cursor.y, viewer.cursor.z],
  );
  const initial = useRef(target.clone());
  useFrame((_, delta) => {
    root.current?.position.lerp(target, 1 - Math.exp(-18 * delta));
  });
  return (
    <group ref={root} position={initial.current}>
      <Html zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div
          className="collaborator-cursor"
          data-viewer={viewer.id}
          aria-label={`${viewer.name}'s cursor`}
          style={{ color: viewer.color }}
        >
          <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
            <path
              d="M1 1L19 16L11 17L7 24Z"
              fill="currentColor"
              stroke="white"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span className="remote-label" style={{ borderColor: viewer.color }}>
            <i style={{ background: viewer.color }} />
            {viewer.name}
          </span>
        </div>
      </Html>
    </group>
  );
}

function MoveHandles({ parts }: { parts: Part[] }) {
  const root = useRef<THREE.Group>(null);
  const labels = useRef<Array<HTMLSpanElement | null>>([]);
  const { camera, size } = useThree();
  const center = useMemo(() => {
    const bs = parts.map(boundsForHandles);
    return new THREE.Vector3(
      (Math.min(...bs.map((b) => b.minx)) +
        Math.max(...bs.map((b) => b.maxx))) /
        12,
      Math.max(...bs.map((b) => b.maxy)) / 6 + 0.12,
      (Math.min(...bs.map((b) => b.minz)) +
        Math.max(...bs.map((b) => b.maxz))) /
        12,
    );
  }, [parts]);
  useFrame(() => {
    if (!root.current) return;
    root.current.scale.setScalar(
      (camera.position.distanceTo(center) *
        Math.tan(
          THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov / 2),
        ) *
        120) /
        size.height,
    );
    const direction = camera.getWorldDirection(new THREE.Vector3());
    root.current.children.forEach((child, i) => {
      child.visible = Math.abs(direction[(["x", "y", "z"] as const)[i]]) < 0.98;
      const label = labels.current[i];
      if (label) label.style.display = child.visible ? "" : "none";
    });
  });
  return (
    <group ref={root} position={center}>
      {(["x", "y", "z"] as const).map((axis, i) => (
        <group
          key={axis}
          rotation={
            axis === "x"
              ? [0, 0, -Math.PI / 2]
              : axis === "z"
                ? [Math.PI / 2, 0, 0]
                : [0, 0, 0]
          }
        >
          <mesh position={[0, 0.65, 0]} renderOrder={10} raycast={() => {}}>
            <cylinderGeometry args={[0.025, 0.025, 1.3, 12]} />
            <meshBasicMaterial
              color={["#cb715b", "#289b74", "#588db5"][i]}
              depthTest={false}
            />
          </mesh>
          <mesh position={[0, 1.4, 0]} renderOrder={10} raycast={() => {}}>
            <coneGeometry args={[0.09, 0.28, 16]} />
            <meshBasicMaterial
              color={["#cb715b", "#289b74", "#588db5"][i]}
              depthTest={false}
            />
          </mesh>
          <mesh position={[0, 0.85, 0]} userData={{ moveAxis: axis }}>
            <cylinderGeometry args={[0.15, 0.15, 1.4, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <Html
            position={[0, 1.75, 0]}
            zIndexRange={[5, 0]}
            center
            style={{ pointerEvents: "none" }}
          >
            <span
              ref={(el) => {
                labels.current[i] = el;
              }}
              className={`move-axis axis-${axis}`}
            >
              {axis.toUpperCase()}
            </span>
          </Html>
        </group>
      ))}
    </group>
  );
}
function Contents(p: Props) {
  const dark = p.theme === "dark";
  const palette = dark
    ? {
        background: "#101214",
        floor: "#14181c",
        edge: "#242a30",
        board: "#30383d",
        grid: "#525f65",
        minorGrid: "#414c52",
        accent: "#34d59a",
      }
    : {
        background: "#edf0f2",
        floor: "#e8ecef",
        edge: "#b9c4ca",
        board: "#d8e1e4",
        grid: "#a0b2ba",
        minorGrid: "#bccbd0",
        accent: "#087b56",
      };
  const selected = p.parts.filter((part) => p.selected.includes(part.id));
  const groups = useMemo(
    () =>
      Object.fromEntries(
        CATALOGUE.map((d) => [d.key, p.parts.filter((p) => p.key === d.key)]),
      ),
    [p.parts],
  );
  return (
    <>
      {p.onMetrics && <FrameStats onMetrics={p.onMetrics} />}
      <color attach="background" args={[palette.background]} />
      <fog attach="fog" args={[palette.background, 65, 120]} />
      <ambientLight intensity={dark ? 1.1 : 1.4} color="#ffffff" />
      <hemisphereLight args={["#eff5ff", dark ? "#748494" : "#c6cfd4", 2]} />
      <directionalLight
        position={[-12, 24, 10]}
        intensity={3.7}
        color="#ffffff"
        castShadow
        shadow-mapSize={p.quality ? [1024, 1024] : [2048, 2048]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-normalBias={0.035}
        shadow-bias={-0.0001}
      />
      <directionalLight
        position={[10, 12, -8]}
        intensity={1.2}
        color="#dbe7ee"
      />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.39, 0]}
        receiveShadow
      >
        <planeGeometry args={[160, 160]} />
        <meshStandardMaterial color={palette.floor} roughness={0.92} />
      </mesh>
      <mesh position={[0, -0.23, 0]} receiveShadow>
        <boxGeometry args={[32.2, 0.34, 32.2]} />
        <meshStandardMaterial color={palette.edge} roughness={0.75} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.048, 0]}
        receiveShadow
        userData={{ cursorSurface: true }}
        onPointerMove={(e) => {
          if (!e.buttons) {
            e.stopPropagation();
            p.onHover(e.point, new THREE.Vector3(0, 1, 0));
          }
        }}
        onClick={(e) => {
          if (e.delta <= 5) {
            e.stopPropagation();
            p.onClick(undefined, e.shiftKey);
          }
        }}
      >
        <planeGeometry args={[32, 32]} />
        <meshStandardMaterial color={palette.board} roughness={0.84} />
      </mesh>
      {p.grid && !p.presentation && (
        <gridHelper
          args={[32, 32, palette.grid, palette.minorGrid]}
          position={[0, -0.043, 0]}
        />
      )}
      <Camera mode={p.cameraMode} />
      <Gestures {...p} />
      {CATALOGUE.map((d) => (
        <Instances
          key={d.key}
          partKey={d.key}
          parts={groups[d.key]}
          selected={p.selected}
          onHover={p.onHover}
          onClick={p.onClick}
        />
      ))}
      {!p.presentation &&
        selected.map((part) => {
          const d = dimensions(part);
          return (
            <mesh
              key={part.id}
              raycast={() => {}}
              position={[
                (part.position.x + d.x / 2) / 6,
                (part.position.y + d.y / 2) / 6,
                (part.position.z + d.z / 2) / 6,
              ]}
            >
              <boxGeometry
                args={[d.x / 6 + 0.035, d.y / 6 + 0.035, d.z / 6 + 0.035]}
              />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              <Edges color={palette.accent} lineWidth={1.5} threshold={15} />
            </mesh>
          );
        })}
      {!p.presentation && p.selectMode && p.canMove && selected.length > 0 && (
        <MoveHandles
          parts={
            p.dragging
              ? p.ghosts.map((g, i) => ({
                  ...g,
                  id: `handle-${i}`,
                  revision: 0,
                }))
              : selected
          }
        />
      )}
      {!p.presentation &&
        p.ghosts.map((part, i) => (
          <Piece
            key={i}
            part={part}
            opacity={0.62}
            tint={p.valid ? "#34d59a" : "#f77569"}
          />
        ))}
      {!p.presentation &&
        p.viewers
          .filter((v) => v.id !== p.guest && v.generation === p.generation)
          .map((v) => (
            <group key={v.id}>
              {v.cursor && (
                <CollaboratorCursor viewer={{ ...v, cursor: v.cursor }} />
              )}
              {v.preview && (
                <Piece part={v.preview} opacity={0.3} tint={v.color} />
              )}
              {p.parts
                .filter((part) => v.selection.includes(part.id))
                .map((part) => {
                  const d = dimensions(part);
                  return (
                    <mesh
                      key={part.id}
                      raycast={() => {}}
                      position={[
                        (part.position.x + d.x / 2) / 6,
                        (part.position.y + d.y / 2) / 6,
                        (part.position.z + d.z / 2) / 6,
                      ]}
                    >
                      <boxGeometry
                        args={[d.x / 6 + 0.08, d.y / 6 + 0.08, d.z / 6 + 0.08]}
                      />
                      <meshBasicMaterial
                        transparent
                        opacity={0}
                        depthWrite={false}
                      />
                      <Edges color={v.color} lineWidth={2} threshold={15} />
                    </mesh>
                  );
                })}
              <Html
                zIndexRange={[5, 0]}
                position={
                  v.preview
                    ? [
                        v.preview.position.x / 6,
                        v.preview.position.y / 6 + 1.8,
                        v.preview.position.z / 6,
                      ]
                    : [0, 0, 0]
                }
                center
                style={{
                  pointerEvents: "none",
                  display: v.preview && !v.cursor ? "block" : "none",
                }}
              >
                <div className="remote-label">
                  <i style={{ background: v.color }} />
                  {v.name}
                </div>
              </Html>
            </group>
          ))}
      {!p.quality && (
        <ContactShadows
          key={`${p.theme}:${p.parts.map((p) => `${p.id}:${p.revision}`).join(",")}`}
          position={[0, -0.039, 0]}
          opacity={dark ? 0.4 : 0.28}
          scale={34}
          blur={2.3}
          far={8}
          resolution={512}
          frames={1}
        />
      )}
    </>
  );
}
function FrameStats({ onMetrics }: { onMetrics: (m: FrameMetrics) => void }) {
  const { gl } = useThree(),
    samples = useRef<number[]>([]),
    started = useRef(performance.now()),
    last = useRef(0);
  useFrame((_, delta) => {
    const now = performance.now();
    if (document.visibilityState !== "visible") {
      started.current = now;
      samples.current = [];
      return;
    }
    if (now - started.current < 2000) return;
    samples.current.push(delta * 1000);
    if (samples.current.length > 600) samples.current.shift();
    if (now - last.current < 1000) return;
    last.current = now;
    const sorted = [...samples.current].sort((a, b) => a - b),
      mean =
        samples.current.reduce((a, b) => a + b, 0) / samples.current.length;
    onMetrics({
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      fps: 1000 / mean,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      samples: sorted.length,
    });
  });
  return null;
}
export default function Scene(p: Props) {
  return (
    <Canvas
      shadows
      dpr={p.quality ? 1 : [1, 1.75]}
      camera={{ position: [22, 22, 27], fov: 40, near: 0.1, far: 180 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.1,
      }}
    >
      <Contents {...p} />
    </Canvas>
  );
}
