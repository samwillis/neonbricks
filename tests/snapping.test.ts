import { describe, it, expect } from "vitest";
import { snapToSurface } from "../src/client/snapping";
import { fitsScene } from "../src/client/movement";
import { connectorList, mating } from "../src/shared/geometry";
import type { Part } from "../src/shared/types";

const part = (
  id: string,
  key = "brick-1x1",
  x = 0,
  y = 0,
  z = 0,
  rotation = 0,
): Part => ({
  id,
  key,
  color: "#289b74",
  position: { x, y, z },
  rotation,
  revision: 1,
});
const connects = (a: Part, b: Part) =>
  connectorList(a).some((c) => connectorList(b).some((d) => mating(c, d)));
const up = { x: 0, y: 1, z: 0 };

describe("surface and attachment snapping", () => {
  it("snaps onto the logical stud height and an off-grid target, preserving the grabbed socket", () => {
    const source = part("a", "brick-1x1", -30),
      target = part("target", "brick-2x2", 1, 6, 5);
    const snap = snapToSurface(
      [source],
      { part: target, point: { x: 4, y: 13.1, z: 8 }, normal: up },
      { x: 30, y: 12, z: 6 },
      [source, target],
      { excluded: [source.id] },
    );
    expect(snap.parts[0].position).toEqual({ x: 1, y: 12, z: 5 });
    expect(connects(snap.parts[0], target)).toBe(true);
    expect(fitsScene(snap.parts, [target])).toBe(true);
  });

  it("translates a group onto a target without changing its offsets or rotations", () => {
    const sources = [
      part("a", "brick-1x1", -30),
      part("b", "brick-1x1", -30, 6, 0, 1),
    ];
    const target = part("target", "brick-2x2");
    const snap = snapToSurface(
      sources,
      { part: target, point: { x: 3, y: 6.5, z: 3 }, normal: up },
      { x: 30, y: 0, z: 0 },
      [target, ...sources],
      { excluded: sources.map((p) => p.id) },
    );
    expect(snap.parts.map((p) => p.position)).toEqual([
      { x: 0, y: 6, z: 0 },
      { x: 0, y: 12, z: 0 },
    ]);
    expect(snap.parts.map((p) => p.rotation)).toEqual([0, 1]);
    expect(connects(snap.parts[0], target)).toBe(true);
    expect(fitsScene(snap.parts, [target])).toBe(true);
  });

  it("keeps an occupied attachment at its target height so it remains invalid", () => {
    const source = part("a"),
      target = part("target", "brick-2x2"),
      blocker = part("blocker", "brick-2x2", 0, 6);
    const snap = snapToSurface(
      [source],
      { part: target, point: { x: 3, y: 6, z: 3 }, normal: up },
      { x: 0, y: 0, z: 0 },
      [target, blocker],
    );
    expect(snap.parts[0].position).toEqual({ x: 0, y: 6, z: 0 });
    expect(fitsScene(snap.parts, [target, blocker])).toBe(false);
  });

  it.each([0, 1, 2, 3])(
    "finds an axle/beam fit with automatic orientation at yaw %s",
    (rotation) => {
      const target = part("target", "beam-3", 12, 0, 12, rotation);
      const hole = connectorList(target).find((c) => c.type === "hole")!;
      const source = part("a", "axle-4", 0, 0, 0, (rotation + 1) % 4);
      const oriented = { ...source, rotation };
      const shaft = connectorList(oriented).find((c) => c.type === "shaft")!;
      const desired = {
        x: hole.at.x - shaft.at.x,
        y: hole.at.y - shaft.at.y + 2,
        z: hole.at.z - shaft.at.z,
      };
      const snap = snapToSurface(
        [source],
        { part: target, point: hole.at, normal: { x: 0, y: 0, z: -1 } },
        desired,
        [target],
        { rotate: true },
      );
      expect(connects(snap.parts[0], target)).toBe(true);
      expect(fitsScene(snap.parts, [target])).toBe(true);
      expect(snap.parts[0].rotation % 2).toBe(rotation % 2);
    },
  );

  it("snaps a moved receiver onto an existing shaft", () => {
    const source = part("a", "bearing", -30),
      target = part("target", "axle-4", 12, 0, 12);
    const snap = snapToSurface(
      [source],
      { part: target, point: { x: 15, y: 3, z: 15 }, normal: up },
      { x: 42, y: 0, z: 12 },
      [source, target],
      { excluded: [source.id] },
    );
    expect(snap.parts[0].position).toEqual({ x: 12, y: 0, z: 12 });
    expect(connects(snap.parts[0], target)).toBe(true);
    expect(fitsScene(snap.parts, [target])).toBe(true);
  });

  it("fits gear and hinge connectors without relying on grid-height rounding", () => {
    const gear = part("target", "gear-20", 10),
      source = part("a", "gear-12");
    const snap = snapToSurface(
      [source],
      {
        part: gear,
        point: { x: 11, y: 9, z: 3 },
        normal: { x: 0, y: 0, z: -1 },
      },
      { x: 0, y: 2, z: 0 },
      [gear],
    );
    expect(snap.parts[0].position).toEqual({ x: 0, y: 3, z: 0 });
    expect(connects(snap.parts[0], gear)).toBe(true);
    expect(fitsScene(snap.parts, [gear])).toBe(true);
    const base = part("base", "hinge-a"),
      leaf = part("leaf", "hinge-b");
    const hinge = snapToSurface(
      [leaf],
      {
        part: base,
        point: { x: 6, y: 1, z: 12 },
        normal: { x: 0, y: 0, z: 1 },
      },
      { x: 0, y: 0, z: 12 },
      [base],
    );
    expect(connects(hinge.parts[0], base)).toBe(true);
    expect(fitsScene(hinge.parts, [base])).toBe(true);
  });

  it("uses rotated bounds for flush side placement and respects an explicit build layer", () => {
    const source = part("a", "brick-1x2", 0, 0, 0, 1),
      target = part("target", "brick-2x2", 18, 12);
    const side = snapToSurface(
      [source],
      {
        part: target,
        point: { x: 18, y: 15, z: 3 },
        normal: { x: -1, y: 0, z: 0 },
      },
      { x: 12, y: 12, z: 0 },
      [target],
    );
    expect(side.parts[0].position.x).toBe(6);
    const manual = snapToSurface(
      [source],
      { part: target, point: { x: 21, y: 18, z: 3 }, normal: up },
      { x: 18, y: 6, z: 0 },
      [target],
      { autoHeight: false },
    );
    expect(manual.parts[0].position.y).toBe(6);
  });
});
