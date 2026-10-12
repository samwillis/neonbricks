import { BY_KEY } from "../shared/catalogue";
import { bounds, connectorList, enclosing, mating } from "../shared/geometry";
import type { Part, Position } from "../shared/types";
import { fitsScene } from "./movement";

// Points use the database's sixth-stud units; normals are world-space vectors.
export type SnapSurface = { part?: Part; point: Position; normal: Position };
export type DragSurface = {
  surface: SnapSurface;
  delta: Position;
  fine: boolean;
};
type Options = {
  excluded?: string[];
  autoHeight?: boolean;
  fine?: boolean;
  rotate?: boolean;
};
const distance = (a: Position, b: Position) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const translated = (parts: Part[], delta: Position) =>
  parts.map((p) => ({
    ...p,
    position: {
      x: p.position.x + delta.x,
      y: p.position.y + delta.y,
      z: p.position.z + delta.z,
    },
  }));

export function snapToSurface(
  sources: Part[],
  surface: SnapSurface,
  desired: Position,
  scene: Part[],
  options: Options = {},
): { delta: Position; parts: Part[] } {
  const automatic = options.autoHeight !== false;
  const box = enclosing(sources, 0);
  const target = surface.part;
  const targetBox = target ? bounds(target) : null;
  const top =
    surface.normal.y > 0.5 ||
    (!!targetBox && surface.point.y >= targetBox.maxy - 1);
  const bottom = surface.normal.y < -0.5;
  // Catch studs from the upper side of a brick too: users should not have to
  // aim at a narrow top polygon or adjust a separate build-layer control.
  const topEdge =
    automatic && !bottom && !!targetBox && surface.point.y > targetBox.maxy - 3;
  const fallback = { ...desired };
  if (automatic && top) fallback.y = (targetBox?.maxy || 0) - box.miny;
  else if (automatic && bottom && targetBox)
    fallback.y = targetBox.miny - box.maxy;
  else if (targetBox) {
    if (surface.normal.x > 0.5) fallback.x = targetBox.maxx - box.minx;
    if (surface.normal.x < -0.5) fallback.x = targetBox.minx - box.maxx;
    if (surface.normal.z > 0.5) fallback.z = targetBox.maxz - box.minz;
    if (surface.normal.z < -0.5) fallback.z = targetBox.minz - box.maxz;
  }
  if (!target) return { delta: fallback, parts: translated(sources, fallback) };

  const targets = connectorList(target).filter((c) => {
    if (c.type === "stud") return (top || topEdge) && !options.fine;
    if (c.type === "socket") return bottom && !options.fine;
    return distance(c.at, surface.point) <= 8 ** 2;
  });
  const variants =
    options.rotate &&
    sources.length === 1 &&
    BY_KEY[sources[0].key].category === "Mechanics"
      ? [0, 1, 2, 3].map((rotation) => [{ ...sources[0], rotation }])
      : [sources];
  const candidates: { delta: Position; sources: Part[]; score: number }[] = [];
  for (const parts of variants)
    for (const source of parts)
      for (const local of connectorList(source))
        for (const remote of targets) {
          if (!mating({ ...local, at: remote.at }, remote)) continue;
          const delta = {
            x: remote.at.x - local.at.x,
            y: remote.at.y - local.at.y,
            z: remote.at.z - local.at.z,
          };
          if (!automatic && delta.y !== desired.y) continue;
          const vertical = local.type === "stud" || local.type === "socket";
          const preference =
            local.type === "socket" && topEdge
              ? { ...desired, y: targetBox!.maxy - box.miny }
              : vertical
                ? fallback
                : desired;
          const error = distance(delta, preference);
          // Magnets stay close to the intended pose instead of jumping to a
          // remote connector on a large part or another member of a group.
          if (error > (vertical ? 6 : 12) ** 2) continue;
          candidates.push({
            delta,
            sources: parts,
            score:
              error +
              distance(remote.at, surface.point) * 0.05 +
              (parts[0].rotation === sources[0].rotation ? 0 : 0.01),
          });
        }
  candidates.sort((a, b) => a.score - b.score);
  const fit = candidates.find((c) =>
    fitsScene(translated(c.sources, c.delta), scene, options.excluded),
  );
  // Keep an occupied attachment red so releasing cannot silently drop beneath it.
  const candidate = fit || candidates[0];
  if (candidate)
    return {
      delta: candidate.delta,
      parts: translated(candidate.sources, candidate.delta),
    };
  return { delta: fallback, parts: translated(sources, fallback) };
}
