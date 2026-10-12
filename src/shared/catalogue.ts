export type Shape =
  | "brick"
  | "plate"
  | "tile"
  | "slope"
  | "wedge"
  | "arch"
  | "window"
  | "round"
  | "beam"
  | "pin"
  | "axle"
  | "bearing"
  | "wheel"
  | "gear"
  | "hinge"
  | "hub"
  | "crank";
export type Definition = {
  key: string;
  name: string;
  category: "Bricks" | "Plates" | "Shapes" | "Mechanics";
  shape: Shape;
  w: number;
  d: number;
  h: number;
  studs: boolean;
  detail?: number;
};
const defs: Definition[] = [];
const add = (
  key: string,
  name: string,
  category: Definition["category"],
  shape: Shape,
  w: number,
  d: number,
  h: number,
  studs = false,
  detail?: number,
) => defs.push({ key, name, category, shape, w, d, h, studs, detail });
for (const [w, d] of [
  [1, 1],
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 2],
  [2, 3],
  [2, 4],
])
  add(`brick-${w}x${d}`, `${w} × ${d} brick`, "Bricks", "brick", w, d, 3, true);
for (const [w, d] of [
  [1, 1],
  [1, 2],
  [1, 4],
  [2, 2],
  [2, 4],
  [4, 4],
])
  add(`plate-${w}x${d}`, `${w} × ${d} plate`, "Plates", "plate", w, d, 1, true);
for (const [w, d] of [
  [1, 1],
  [1, 2],
  [2, 2],
])
  add(`tile-${w}x${d}`, `${w} × ${d} tile`, "Plates", "tile", w, d, 1);
add("slope-2x2", "2 × 2 slope", "Shapes", "slope", 2, 2, 3);
add("slope-1x2", "1 × 2 slope", "Shapes", "slope", 1, 2, 3);
add("wedge", "Wing wedge", "Shapes", "wedge", 2, 3, 1, true);
add("arch", "4-stud arch", "Shapes", "arch", 4, 1, 6, true);
add("window", "Window frame", "Shapes", "window", 3, 1, 6);
add("round", "Round brick", "Shapes", "round", 1, 1, 3, true);
for (const n of [3, 5, 7])
  add(`beam-${n}`, `${n}-hole beam`, "Mechanics", "beam", n, 1, 3);
add("pin", "Connector pin", "Mechanics", "pin", 1, 2, 3);
for (const n of [4, 6])
  add(`axle-${n}`, `${n}-stud axle`, "Mechanics", "axle", 1, n, 3);
add("bearing", "Axle bearing", "Mechanics", "bearing", 1, 1, 3);
add("wheel", "Wheel + tyre", "Mechanics", "wheel", 3, 1, 9);
add("gear-12", "12-tooth gear", "Mechanics", "gear", 2, 1, 6, false, 12);
add("gear-20", "20-tooth gear", "Mechanics", "gear", 3, 1, 9, false, 20);
add("hinge-a", "Hinge · base", "Mechanics", "hinge", 2, 2, 1, true, 0);
add("hinge-b", "Hinge · leaf", "Mechanics", "hinge", 2, 2, 1, true, 1);
add("hub", "Wheel hub", "Mechanics", "hub", 1, 1, 3);
add("crank", "Crank handle", "Mechanics", "crank", 1, 2, 6);
export const CATALOGUE = defs;
export const BY_KEY = Object.fromEntries(defs.map((d) => [d.key, d])) as Record<
  string,
  Definition
>;
export const COLORS = [
  { name: "Jade", hex: "#289b74" },
  { name: "Marigold", hex: "#edbc46" },
  { name: "Poppy", hex: "#d9594e" },
  { name: "Sky", hex: "#72a6c8" },
  { name: "Cobalt", hex: "#486fa4" },
  { name: "Lilac", hex: "#a18ab9" },
  { name: "Porcelain", hex: "#eee8dc" },
  { name: "Blush", hex: "#d6a99a" },
  { name: "Tangerine", hex: "#db8650" },
  { name: "Graphite", hex: "#3c4445" },
  { name: "Sand", hex: "#b9aa88" },
  { name: "Seafoam", hex: "#9fc5b4" },
];
