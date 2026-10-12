import { BY_KEY, type Definition } from "./catalogue";
import {
  UNIT,
  WORLD_LIMIT,
  HEIGHT_LIMIT,
  BUCKET,
  type Part,
  type Position,
} from "./types";
export type Bounds = {
  minx: number;
  miny: number;
  minz: number;
  maxx: number;
  maxy: number;
  maxz: number;
};
export type Connector = {
  id: string;
  type:
    "stud" | "socket" | "hole" | "shaft" | "gear" | "hingeBase" | "hingeLeaf";
  at: Position;
  axis: string;
  exclusive: boolean;
  direction?: Position;
};
const masks = new Map<string, Position[]>();
export function dimensions(p: Pick<Part, "key" | "rotation">) {
  const d = BY_KEY[p.key];
  return {
    x: (p.rotation % 2 ? d.d : d.w) * UNIT,
    y: d.h * 2,
    z: (p.rotation % 2 ? d.w : d.d) * UNIT,
  };
}
export function bounds(p: Part): Bounds {
  const d = dimensions(p);
  return {
    minx: p.position.x,
    miny: p.position.y,
    minz: p.position.z,
    maxx: p.position.x + d.x,
    maxy: p.position.y + d.y,
    maxz: p.position.z + d.z,
  };
}
export function validPart(p: Part) {
  if (
    !BY_KEY[p.key] ||
    !/^#[\da-f]{6}$/i.test(p.color) ||
    !Number.isInteger(p.rotation) ||
    p.rotation < 0 ||
    p.rotation > 3
  )
    return false;
  if (!Object.values(p.position).every(Number.isSafeInteger)) return false;
  const b = bounds(p);
  return (
    b.minx >= -WORLD_LIMIT &&
    b.minz >= -WORLD_LIMIT &&
    b.miny >= 0 &&
    b.maxx <= WORLD_LIMIT &&
    b.maxz <= WORLD_LIMIT &&
    b.maxy <= HEIGHT_LIMIT
  );
}
function solid(d: Definition, x: number, y: number, z: number) {
  const h = d.h / 3,
    cx = x - d.w / 2,
    cy = y - h / 2;
  switch (d.shape) {
    case "crank":
      return (
        (z < 0.6 && Math.hypot(x - 0.5, y - 0.5) > 0.27) ||
        (z > 0.55 && Math.hypot(x - 0.5, y - 1.5) < 0.18)
      );
    case "round":
      return Math.hypot(x - 0.5, z - 0.5) < 0.48;
    case "slope":
      return y < 0.25 + (h - 0.25) * (1 - z / d.d);
    case "wedge":
      return x < d.w * (1 - (z / d.d) * 0.7);
    case "arch":
      return y > h - 0.5 || x < 0.6 || x > d.w - 0.6;
    case "window":
      return y < 0.25 || y > h - 0.25 || x < 0.25 || x > d.w - 0.25;
    case "beam":
      return Math.hypot(x - (Math.floor(x) + 0.5), y - 0.5) > 0.27;
    case "bearing":
    case "hub":
      return Math.hypot(x - 0.5, y - 0.5) > 0.27;
    case "axle":
      return (
        (Math.abs(x - 0.5) < 0.14 && Math.abs(y - 0.5) < 0.25) ||
        (Math.abs(x - 0.5) < 0.25 && Math.abs(y - 0.5) < 0.14)
      );
    case "pin":
      return Math.hypot(x - 0.5, y - 0.5) < 0.17;
    case "wheel":
      return Math.hypot(cx, cy) < 1.4 && Math.hypot(cx, cy) > 0.27;
    case "gear": {
      const a = Math.atan2(cy, cx),
        r = Math.hypot(cx, cy);
      return (
        r > 0.27 && r < d.w / 2 - 0.13 + 0.1 * Math.cos(a * (d.detail || 12))
      );
    }
    default:
      return true;
  }
}
function localMask(key: string) {
  if (masks.has(key)) return masks.get(key)!;
  const d = BY_KEY[key],
    result: Position[] = [];
  for (let x = 0; x < d.w * UNIT; x++)
    for (let y = 0; y < d.h * 2; y++)
      for (let z = 0; z < d.d * UNIT; z++)
        if (solid(d, (x + 0.5) / UNIT, (y + 0.5) / UNIT, (z + 0.5) / UNIT))
          result.push({ x, y, z });
  masks.set(key, result);
  return result;
}
export function rotateLocal(p: Part, v: Position, cell = false): Position {
  const d = BY_KEY[p.key],
    w = d.w * UNIT,
    h = d.d * UNIT,
    k = cell ? 1 : 0;
  const r =
    p.rotation === 0
      ? { x: v.x, z: v.z }
      : p.rotation === 1
        ? { x: h - v.z - k, z: v.x }
        : p.rotation === 2
          ? { x: w - v.x - k, z: h - v.z - k }
          : { x: v.z, z: w - v.x - k };
  return {
    x: r.x + p.position.x,
    y: v.y + p.position.y,
    z: r.z + p.position.z,
  };
}
export function mask(p: Part) {
  return localMask(p.key).map((v) => rotateLocal(p, v, true));
}
const cellKey = (v: Position) => `${v.x},${v.y},${v.z}`;
export function intersects(a: Bounds, b: Bounds) {
  return (
    a.minx < b.maxx &&
    a.maxx > b.minx &&
    a.miny < b.maxy &&
    a.maxy > b.miny &&
    a.minz < b.maxz &&
    a.maxz > b.minz
  );
}
export function collision(a: Part, b: Part) {
  if (!intersects(bounds(a), bounds(b))) return false;
  const occupied = new Set(mask(a).map(cellKey));
  return mask(b).some((v) => occupied.has(cellKey(v)));
}
export function connectorList(p: Part): Connector[] {
  const d = BY_KEY[p.key],
    list: Connector[] = [],
    axis = p.rotation % 2 ? "x" : "z";
  const add = (
    id: string,
    type: Connector["type"],
    v: Position,
    exclusive = true,
  ) =>
    list.push({
      id,
      type,
      at: rotateLocal(p, v),
      axis: type === "stud" || type === "socket" ? "y" : axis,
      exclusive,
    });
  if (d.studs)
    for (let x = 0; x < d.w; x++)
      for (let z = 0; z < d.d; z++)
        add(`s${x}:${z}`, "stud", { x: x * 6 + 3, y: d.h * 2, z: z * 6 + 3 });
  if (
    [
      "brick",
      "plate",
      "tile",
      "round",
      "slope",
      "wedge",
      "arch",
      "window",
      "hinge",
    ].includes(d.shape)
  )
    for (let x = 0; x < d.w; x++)
      for (let z = 0; z < d.d; z++)
        if (solid(d, x + 0.5, 0.05, z + 0.5))
          add(`b${x}:${z}`, "socket", { x: x * 6 + 3, y: 0, z: z * 6 + 3 });
  if (d.shape === "beam")
    for (let x = 0; x < d.w; x++)
      add(`h${x}`, "hole", { x: x * 6 + 3, y: 3, z: 3 });
  if (["bearing", "hub", "wheel", "gear"].includes(d.shape))
    add("h0", "hole", { x: d.w * 3, y: d.h, z: 3 });
  if (d.shape === "crank") add("h0", "hole", { x: 3, y: 3, z: 3 });
  if (d.shape === "pin" || d.shape === "axle")
    for (let z = 0; z < d.d; z++)
      add(`a${z}`, "shaft", { x: 3, y: 3, z: z * 6 + 3 }, false);
  if (d.shape === "gear") {
    const radius = d.w * 3 - 1;
    for (const [id, dx, dy] of [
      ["left", -1, 0],
      ["right", 1, 0],
      ["up", 0, 1],
      ["down", 0, -1],
    ] as const) {
      const center = { x: d.w * 3, y: d.h, z: 3 },
        local = { x: center.x + dx * radius, y: center.y + dy * radius, z: 3 };
      const origin = rotateLocal(p, { x: 0, y: 0, z: 0 }),
        vector = rotateLocal(p, { x: dx, y: dy, z: 0 });
      list.push({
        id: `g-${id}`,
        type: "gear",
        at: rotateLocal(p, local),
        axis,
        exclusive: true,
        direction: { x: vector.x - origin.x, y: dy, z: vector.z - origin.z },
      });
    }
  }
  if (d.shape === "hinge")
    list.push({
      id: "pivot",
      type: d.detail ? "hingeLeaf" : "hingeBase",
      at: rotateLocal(p, { x: 6, y: 1, z: d.detail ? 0 : 12 }),
      axis: p.rotation % 2 ? "z" : "x",
      exclusive: true,
    });
  return list;
}
export function mating(a: Connector, b: Connector) {
  if (
    a.axis !== b.axis ||
    a.at.x !== b.at.x ||
    a.at.y !== b.at.y ||
    a.at.z !== b.at.z
  )
    return false;
  if (a.type === "gear" && b.type === "gear")
    return (
      !!a.direction &&
      !!b.direction &&
      a.direction.x === -b.direction.x &&
      a.direction.y === -b.direction.y &&
      a.direction.z === -b.direction.z
    );
  if (
    (a.type === "hingeBase" && b.type === "hingeLeaf") ||
    (b.type === "hingeBase" && a.type === "hingeLeaf")
  )
    return true;
  return (
    (a.type === "stud" && b.type === "socket") ||
    (b.type === "stud" && a.type === "socket") ||
    (a.type === "shaft" && b.type === "hole") ||
    (b.type === "shaft" && a.type === "hole")
  );
}
export function bucketKeys(parts: Part[]) {
  const set = new Set<string>();
  for (const p of parts) {
    const b = bounds(p);
    for (
      let x = Math.floor((b.minx - 2) / BUCKET);
      x <= Math.floor((b.maxx + 2) / BUCKET);
      x++
    )
      for (
        let y = Math.floor((b.miny - 2) / BUCKET);
        y <= Math.floor((b.maxy + 2) / BUCKET);
        y++
      )
        for (
          let z = Math.floor((b.minz - 2) / BUCKET);
          z <= Math.floor((b.maxz + 2) / BUCKET);
          z++
        )
          set.add(`${x},${y},${z}`);
  }
  return [...set].sort((a, b) => {
    const aa = a.split(",").map(Number),
      bb = b.split(",").map(Number);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
  });
}
export function enclosing(parts: Part[], pad = 2): Bounds {
  const bs = parts.map(bounds);
  return {
    minx: Math.min(...bs.map((b) => b.minx)) - pad,
    miny: Math.min(...bs.map((b) => b.miny)) - pad,
    minz: Math.min(...bs.map((b) => b.minz)) - pad,
    maxx: Math.max(...bs.map((b) => b.maxx)) + pad,
    maxy: Math.max(...bs.map((b) => b.maxy)) + pad,
    maxz: Math.max(...bs.map((b) => b.maxz)) + pad,
  };
}
