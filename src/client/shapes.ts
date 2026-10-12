import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Definition } from "../shared/catalogue";
export type Model = {
  body: THREE.BufferGeometry;
  detail?: THREE.BufferGeometry;
};
const cache = new Map<string, Model>();
function rectangle(w: number, h: number, r = 0.04) {
  const s = new THREE.Shape(),
    x = 0.035,
    y = 0.035,
    a = w - 0.07,
    b = h - 0.07;
  s.moveTo(x + r, y);
  s.lineTo(x + a - r, y);
  s.quadraticCurveTo(x + a, y, x + a, y + r);
  s.lineTo(x + a, y + b - r);
  s.quadraticCurveTo(x + a, y + b, x + a - r, y + b);
  s.lineTo(x + r, y + b);
  s.quadraticCurveTo(x, y + b, x, y + b - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function hole(s: THREE.Shape, x: number, y: number, r: number) {
  const p = new THREE.Path();
  p.absarc(x, y, r, 0, Math.PI * 2, true);
  s.holes.push(p);
}
function extrude(s: THREE.Shape, depth: number, z = 0.035) {
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.04, depth - 0.07),
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.018,
    bevelThickness: 0.018,
    curveSegments: 16,
  });
  g.translate(0, 0, z);
  return g;
}
function cylinder(
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  axis: "y" | "z" = "y",
  r2 = r,
) {
  const g = new THREE.CylinderGeometry(r, r2, h, 20, 1);
  if (axis === "z") g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}
const merge = (gs: THREE.BufferGeometry[]) =>
  mergeGeometries(
    gs.map((g) => (g.index ? g.toNonIndexed() : g)),
    false,
  )!;
export function model(d: Definition): Model {
  if (cache.has(d.key)) return cache.get(d.key)!;
  const h = d.h / 3,
    body: THREE.BufferGeometry[] = [],
    detail: THREE.BufferGeometry[] = [];
  switch (d.shape) {
    case "crank": {
      const s = rectangle(1, 2, 0.28);
      hole(s, 0.5, 0.5, 0.27);
      body.push(extrude(s, 0.6));
      detail.push(cylinder(0.17, 1.3, 0.5, 1.5, 1.22, "z"));
      break;
    }
    case "beam": {
      const s = rectangle(d.w, 1, 0.42);
      for (let x = 0; x < d.w; x++) hole(s, x + 0.5, 0.5, 0.27);
      body.push(extrude(s, d.d));
      break;
    }
    case "bearing":
    case "hub": {
      const s = rectangle(1, 1, 0.12);
      hole(s, 0.5, 0.5, 0.27);
      body.push(extrude(s, 1));
      break;
    }
    case "gear": {
      const s = new THREE.Shape(),
        n = (d.detail || 12) * 4,
        r = d.w / 2 - 0.08;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2,
          rr = r - ([0, 3].includes(i % 4) ? 0.19 : 0),
          x = d.w / 2 + Math.cos(t) * rr,
          y = h / 2 + Math.sin(t) * rr;
        i ? s.lineTo(x, y) : s.moveTo(x, y);
      }
      s.closePath();
      hole(s, d.w / 2, h / 2, 0.27);
      body.push(extrude(s, 0.5, 0.25));
      const hub = new THREE.Shape();
      hub.absarc(d.w / 2, h / 2, 0.48, 0, Math.PI * 2, false);
      hole(hub, d.w / 2, h / 2, 0.27);
      detail.push(extrude(hub, 0.6, 0.2));
      break;
    }
    case "wheel": {
      const tyre = new THREE.Shape();
      tyre.absarc(1.5, 1.5, 1.36, 0, Math.PI * 2, false);
      hole(tyre, 1.5, 1.5, 0.73);
      body.push(extrude(tyre, 0.84, 0.08));
      const hub = new THREE.Shape();
      hub.absarc(1.5, 1.5, 0.77, 0, Math.PI * 2, false);
      hole(hub, 1.5, 1.5, 0.27);
      detail.push(extrude(hub, 0.87, 0.065));
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * Math.PI * 2;
        detail.push(
          cylinder(
            0.075,
            0.9,
            1.5 + 0.5 * Math.cos(t),
            1.5 + 0.5 * Math.sin(t),
            0.5,
            "z",
          ),
        );
      }
      break;
    }
    case "axle": {
      const s = new THREE.Shape();
      const xy = [
        [-0.12, -0.24],
        [0.12, -0.24],
        [0.12, -0.12],
        [0.24, -0.12],
        [0.24, 0.12],
        [0.12, 0.12],
        [0.12, 0.24],
        [-0.12, 0.24],
        [-0.12, 0.12],
        [-0.24, 0.12],
        [-0.24, -0.12],
        [-0.12, -0.12],
      ];
      xy.forEach(([x, y], i) =>
        i ? s.lineTo(0.5 + x, 0.5 + y) : s.moveTo(0.5 + x, 0.5 + y),
      );
      s.closePath();
      body.push(extrude(s, d.d));
      break;
    }
    case "pin": {
      body.push(cylinder(0.165, d.d - 0.07, 0.5, 0.5, d.d / 2, "z"));
      detail.push(cylinder(0.21, 0.12, 0.5, 0.5, 0.12, "z"));
      break;
    }
    case "round":
      body.push(cylinder(0.46, h - 0.06, 0.5, h / 2, 0.5));
      break;
    case "slope": {
      const s = new THREE.Shape();
      s.moveTo(0.035, 0.035);
      s.lineTo(d.d - 0.035, 0.035);
      s.lineTo(d.d - 0.035, 0.23);
      s.lineTo(0.035, h - 0.035);
      s.closePath();
      const g = extrude(s, d.w);
      g.rotateY(-Math.PI / 2);
      g.translate(d.w, 0, 0);
      body.push(g);
      break;
    }
    case "wedge": {
      const s = new THREE.Shape();
      s.moveTo(0.035, 0.035);
      s.lineTo(d.w - 0.035, 0.035);
      s.lineTo(d.w * 0.3, d.d - 0.035);
      s.lineTo(0.035, d.d - 0.035);
      s.closePath();
      const g = extrude(s, h);
      g.rotateX(Math.PI / 2);
      g.translate(0, h, 0);
      body.push(g);
      break;
    }
    case "arch": {
      const s = new THREE.Shape();
      s.moveTo(0.035, 0.035);
      s.lineTo(0.6, 0.035);
      s.lineTo(0.6, h - 0.5);
      s.lineTo(d.w - 0.6, h - 0.5);
      s.lineTo(d.w - 0.6, 0.035);
      s.lineTo(d.w - 0.035, 0.035);
      s.lineTo(d.w - 0.035, h - 0.035);
      s.lineTo(0.035, h - 0.035);
      s.closePath();
      body.push(extrude(s, d.d));
      break;
    }
    case "window": {
      const s = rectangle(d.w, h, 0.05);
      const p = new THREE.Path();
      p.moveTo(0.25, 0.25);
      p.lineTo(0.25, h - 0.25);
      p.lineTo(d.w - 0.25, h - 0.25);
      p.lineTo(d.w - 0.25, 0.25);
      p.closePath();
      s.holes.push(p);
      body.push(extrude(s, d.d));
      break;
    }
    case "hinge": {
      // Alternating knuckles meet at the fixed, coplanar launch pose.
      body.push(
        extrude(rectangle(d.w, h), d.d - 0.18, d.detail ? 0.18 : 0.035),
      );
      for (let i = d.detail ? 1 : 0; i < 6; i += 2) {
        const g = cylinder(0.13, 0.29, 0, 0, 0);
        g.rotateZ(Math.PI / 2);
        g.translate((i + 0.5) / 3, h / 2, d.detail ? 0 : d.d);
        detail.push(g);
      }
      break;
    }
    default: {
      body.push(extrude(rectangle(d.w, h), d.d));
    }
  }
  if (d.studs)
    for (let x = 0; x < d.w; x++)
      for (let z = 0; z < d.d; z++)
        if (
          d.shape !== "wedge" ||
          x + 0.5 < d.w * (1 - ((z + 0.5) / d.d) * 0.7)
        )
          body.push(cylinder(0.275, 0.16, x + 0.5, h + 0.07, z + 0.5));
  const m = {
    body: merge(body),
    detail: detail.length ? merge(detail) : undefined,
  };
  cache.set(d.key, m);
  return m;
}
let thumbnailRenderer: THREE.WebGLRenderer | undefined;
const thumbs = new Map<string, string>();
export function thumbnail(d: Definition, theme: "light" | "dark") {
  const cacheKey = `${d.key}:${theme}`;
  if (thumbs.has(cacheKey)) return thumbs.get(cacheKey)!;
  if (!thumbnailRenderer) {
    thumbnailRenderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    thumbnailRenderer.setSize(224, 160);
    thumbnailRenderer.setPixelRatio(1);
    thumbnailRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const scene = new THREE.Scene(),
    m = model(d),
    group = new THREE.Group();
  const color =
    d.shape === "wheel"
      ? theme === "dark"
        ? "#737f8c"
        : "#3c4445"
      : d.category === "Mechanics"
        ? theme === "dark"
          ? "#b0bbc8"
          : "#83929c"
        : d.category === "Shapes"
          ? "#edbc46"
          : theme === "dark"
            ? "#34d59a"
            : "#37c38f";
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.32 }),
    detailMat = new THREE.MeshStandardMaterial({
      color: "#b2bcc7",
      roughness: 0.4,
    });
  group.add(new THREE.Mesh(m.body, mat));
  if (m.detail) group.add(new THREE.Mesh(m.detail, detailMat));
  group.position.set(-d.w / 2, -d.h / 6, -d.d / 2);
  scene.add(group);
  scene.add(new THREE.AmbientLight("#ffffff", 2.4));
  const light = new THREE.DirectionalLight("#ffffff", 4);
  light.position.set(-4, 8, 5);
  scene.add(light);
  const size = Math.max(d.w, d.d, d.h / 3) * 0.78 + 0.25,
    camera = new THREE.OrthographicCamera(
      -size * 1.4,
      size * 1.4,
      size,
      -size,
      0.1,
      100,
    );
  camera.position.set(7, 6, 9);
  camera.lookAt(0, 0, 0);
  thumbnailRenderer.render(scene, camera);
  const url = thumbnailRenderer.domElement.toDataURL("image/png");
  thumbs.set(cacheKey, url);
  mat.dispose();
  detailMat.dispose();
  return url;
}
