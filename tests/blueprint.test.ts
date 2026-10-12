import { describe, expect, it } from "vitest";
import {
  blueprintSchema,
  compileBlueprint,
  MAX_AI_PARTS,
  type Blueprint,
} from "../src/shared/blueprint";
import { CATALOGUE_VERSION } from "../src/shared/types";
const part = (
  id: string,
  key: string,
  at: [number, number, number],
): Blueprint["parts"][number] => ({
  id,
  part: key,
  at,
  colour: "jade",
  turn: 0,
  attach: null,
});
const blueprint = (parts: Blueprint["parts"]): Blueprint => ({
  version: 1,
  catalogue: CATALOGUE_VERSION,
  title: "Test build",
  summary: "A test build.",
  parts,
});
describe("AI blueprint compiler", () => {
  it("converts studs and plate heights and derives a connected stack", () => {
    const result = compileBlueprint(
      blueprint([
        part("base", "plate-4x4", [-2, 0, -2]),
        part("body", "brick-2x2", [-1, 1, -1]),
        part("roof", "slope-2x2", [-1, 4, -1]),
      ]),
    );
    expect(result.issues).toEqual([]);
    expect(result.parts[1].position).toEqual({ x: -6, y: 2, z: -6 });
    expect(result.edges.length).toBeGreaterThan(1);
  });
  it("solves connector placements including forward references", () => {
    const attached = {
      ...part("top", "brick-1x1", [0, 0, 0]),
      at: null,
      attach: { to: "base", connector: "s0:0", ownConnector: "b0:0" },
    };
    const result = compileBlueprint(
      blueprint([attached, part("base", "brick-2x2", [0, 0, 0])]),
    );
    expect(result.issues).toEqual([]);
    expect(result.parts.find((p) => p.id === "top")!.position.y).toBe(6);
  });
  it("fits a wheel onto an axle through their authored channels", () => {
    const wheel = part("wheel", "wheel", [0, 0, 0]);
    const axle = {
      ...part("axle", "axle-4", [0, 0, 0]),
      at: null,
      attach: { to: "wheel", connector: "h0", ownConnector: "a0" },
    };
    expect(compileBlueprint(blueprint([wheel, axle])).issues).toEqual([]);
  });
  it("reports named collision pairs", () => {
    const result = compileBlueprint(
      blueprint([
        part("a", "brick-2x2", [0, 0, 0]),
        part("b", "brick-1x1", [1, 0, 1]),
      ]),
    );
    expect(result.issues).toContainEqual({
      code: "overlap",
      parts: ["a", "b"],
      message: expect.any(String),
    });
  });
  it("allows separate grounded objects but rejects floating assemblies", () => {
    const result = compileBlueprint(
      blueprint([
        part("a", "brick-1x1", [0, 0, 0]),
        part("b", "brick-1x1", [3, 0, 0]),
        part("floating", "brick-1x1", [5, 3, 0]),
      ]),
    );
    expect(result.issues.map((i) => i.parts)).toEqual([["floating"]]);
  });
  it("rejects cycles, duplicate IDs, and ambiguous placements", () => {
    const a = {
      ...part("a", "brick-1x1", [0, 0, 0]),
      at: null,
      attach: { to: "b", connector: "s0:0", ownConnector: "b0:0" },
    };
    const b = { ...a, id: "b", attach: { ...a.attach, to: "a" } };
    expect(
      compileBlueprint(blueprint([a, b])).issues.some(
        (i) => i.code === "attachment_cycle",
      ),
    ).toBe(true);
    expect(
      compileBlueprint(
        blueprint([
          part("same", "brick-1x1", [0, 0, 0]),
          part("same", "brick-1x1", [2, 0, 0]),
        ]),
      ).issues.some((i) => i.code === "duplicate_id"),
    ).toBe(true);
    expect(
      compileBlueprint(
        blueprint([{ ...a, at: [0, 0, 0] }, part("b", "brick-1x1", [0, 0, 0])]),
      ).issues.some((i) => i.code === "placement"),
    ).toBe(true);
  });
  it("rejects unknown parts, colours and unsupported format versions", () => {
    for (const change of [
      { version: 2 },
      { catalogue: "future" },
      { parts: [part("x", "imaginary-motor", [0, 0, 0])] },
      {
        parts: [{ ...part("x", "brick-1x1", [0, 0, 0]), colour: "invisible" }],
      },
    ])
      expect(
        blueprintSchema.safeParse({
          ...blueprint([part("x", "brick-1x1", [0, 0, 0])]),
          ...change,
        }).success,
      ).toBe(false);
  });
  it("checks rotated bounds, exact lattice alignment and expanded part count", () => {
    expect(
      compileBlueprint(
        blueprint([{ ...part("x", "brick-1x4", [15, 0, 0]), turn: 1 }]),
      ).issues.some((i) => i.code === "bounds"),
    ).toBe(true);
    expect(
      compileBlueprint(
        blueprint([part("x", "brick-1x1", [0.1, 0, 0])]),
      ).issues.some((i) => i.code === "grid"),
    ).toBe(true);
    expect(
      blueprintSchema.safeParse(
        blueprint(
          Array.from({ length: MAX_AI_PARTS + 1 }, (_, i) =>
            part(`p${i}`, "brick-1x1", [0, 0, 0]),
          ),
        ),
      ).success,
    ).toBe(false);
  });
});
