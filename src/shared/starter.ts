import type { Part } from "./types";
export function starter(id: () => string): Part[] {
  const list: Part[] = [];
  const add = (
    key: string,
    color: string,
    x: number,
    y: number,
    z: number,
    rotation = 0,
  ) =>
    list.push({
      id: id(),
      key,
      color,
      position: { x: x * 6, y: y * 2, z: z * 6 },
      rotation,
      revision: 1,
    });
  // A rover with real clearance around its wheels, plus a small mechanic's bench.
  for (const z of [-2, 2]) {
    add("axle-6", "#b9aa88", -3, 3, z, 1);
    add("wheel", "#3c4445", -3, 0, z - 1, 1);
    add("wheel", "#3c4445", 2, 0, z - 1, 1);
  }
  add("plate-2x4", "#289b74", -1, 5, -2);
  add("brick-1x4", "#289b74", -1, 6, -2);
  add("brick-1x4", "#289b74", 0, 6, -2);
  add("plate-2x4", "#edbc46", -1, 9, -2);
  add("slope-2x2", "#edbc46", -1, 10, 0);
  add("tile-2x2", "#eee8dc", -1, 10, -2);
  add("brick-1x1", "#d9594e", -1, 11, -2);
  add("brick-1x1", "#d9594e", 0, 11, -2);
  add("plate-2x4", "#72a6c8", 5, 0, -4);
  add("brick-1x1", "#72a6c8", 5, 1, -4);
  add("brick-1x1", "#72a6c8", 6, 1, -4);
  add("brick-1x1", "#72a6c8", 5, 1, -1);
  add("brick-1x1", "#72a6c8", 6, 1, -1);
  add("plate-2x4", "#b9aa88", 5, 4, -4);
  add("beam-3", "#d9594e", 5, 5, -4);
  add("gear-12", "#edbc46", 5, 5, -2);
  add("round", "#eee8dc", 6, 5, -1);
  // A few spare components on the workbench surface.
  add("brick-2x2", "#d9594e", -6, 0, 4);
  add("plate-1x4", "#72a6c8", -3, 0, 5, 1);
  add("gear-20", "#b9aa88", 4, 0, 4);
  return list;
}
