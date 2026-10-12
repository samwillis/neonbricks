import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { CATALOGUE } from "../src/shared/catalogue";
import {
  bounds,
  collision,
  validPart,
  connectorList,
  mating,
  bucketKeys,
  mask,
} from "../src/shared/geometry";
import { starter } from "../src/shared/starter";
import type { Part } from "../src/shared/types";
const part = (key: string, x = 0, y = 0, z = 0, rotation = 0): Part => ({
  id: randomUUID(),
  key,
  color: "#289b74",
  position: { x, y, z },
  rotation,
  revision: 1,
});
const connects = (a: Part, b: Part) =>
  connectorList(a).some((c) => connectorList(b).some((d) => mating(c, d)));
describe("catalogue collision and fit contract", () => {
  it("has 36 valid nonempty proxies in all four supported poses", () => {
    expect(CATALOGUE).toHaveLength(36);
    for (const d of CATALOGUE)
      for (let r = 0; r < 4; r++) {
        const p = part(d.key, 0, 0, 0, r);
        expect(validPart(p), `${d.key}/${r}`).toBe(true);
        expect(mask(p).length).toBeGreaterThan(0);
        expect(collision(p, { ...p, id: randomUUID() })).toBe(true);
      }
  });
  it("mates studs without overlapping bodies", () => {
    const a = part("brick-1x1"),
      b = part("brick-1x1", 0, 6);
    expect(collision(a, b)).toBe(false);
    expect(connects(a, b)).toBe(true);
    expect(connects(a, part("brick-1x1", 6, 6))).toBe(false);
  });
  it("fits shafts through beams, bearings, gears and wheels in each pose", () => {
    for (let r = 0; r < 4; r++)
      for (const key of [
        "beam-3",
        "bearing",
        "gear-12",
        "gear-20",
        "wheel",
        "hub",
        "crank",
      ]) {
        const b = part(key, 12, 12, 12, r),
          hole = connectorList(b).find((c) => c.type === "hole")!;
        const a = part("axle-4", 0, 0, 0, r),
          shaft = connectorList(a).find((c) => c.type === "shaft")!;
        a.position = {
          x: hole.at.x - shaft.at.x,
          y: hole.at.y - shaft.at.y,
          z: hole.at.z - shaft.at.z,
        };
        expect(collision(a, b), `${key}/${r}`).toBe(false);
        expect(connects(a, b)).toBe(true);
        a.position.y += 2;
        expect(collision(a, b)).toBe(true);
      }
  });
  it("rejects incompatible connectors", () => {
    const a = connectorList(part("brick-1x1")).find((c) => c.type === "stud")!;
    expect(mating(a, a)).toBe(false);
  });
  it("mates the authored static gear pose and paired hinge leaves", () => {
    const a = part("gear-12", 0, 3),
      b = part("gear-20", 10, 0);
    expect(collision(a, b)).toBe(false);
    expect(connects(a, b)).toBe(true);
    expect(connects(a, part("gear-20", 11, 0))).toBe(false);
    const h = part("hinge-a"),
      leaf = part("hinge-b", 0, 0, 12);
    expect(collision(h, leaf)).toBe(false);
    expect(connects(h, leaf)).toBe(true);
    expect(connects(h, part("hinge-a", 0, 0, 12))).toBe(false);
    const turn = (p: Part): Part => {
      const b = bounds(p);
      return {
        ...p,
        rotation: (p.rotation + 1) % 4,
        position: { x: -b.maxz, y: p.position.y, z: b.minx },
      };
    };
    for (const [left, right] of [
      [a, b],
      [h, leaf],
      [part("gear-12"), part("gear-12", 10)],
      [part("gear-20"), part("gear-20", 16)],
    ]) {
      let one = left,
        two = right;
      for (let r = 0; r < 4; r++) {
        expect(collision(one, two)).toBe(false);
        expect(connects(one, two)).toBe(true);
        one = turn(one);
        two = turn(two);
      }
    }
  });
  it("covers touching and intersecting neighbours across bucket boundaries", () => {
    const a = part("brick-1x1", 23),
      b = part("brick-1x1", 29);
    expect(bucketKeys([a]).some((k) => bucketKeys([b]).includes(k))).toBe(true);
    const c = part("brick-1x1", -60, 0, -60);
    expect(bucketKeys([a]).some((k) => bucketKeys([c]).includes(k))).toBe(
      false,
    );
  });
  it("validates the complete starter and every pair", () => {
    const ps = starter(randomUUID);
    for (let i = 0; i < ps.length; i++) {
      expect(validPart(ps[i])).toBe(true);
      for (let j = 0; j < i; j++)
        expect(collision(ps[i], ps[j]), `${ps[i].key}/${ps[j].key}`).toBe(
          false,
        );
    }
  });
  it("enforces integer coordinates and board limits", () => {
    expect(validPart(part("brick-1x1", 95))).toBe(false);
    expect(validPart(part("brick-1x1", 0.5))).toBe(false);
    expect(bounds(part("brick-1x2", 0, 0, 0, 1)).maxx).toBe(12);
  });
});
