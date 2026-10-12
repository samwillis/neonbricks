import { describe, it, expect } from "vitest";
import {
  captureMove,
  fitsScene,
  movedParts,
  moveRequest,
  snapMovement,
} from "../src/client/movement";
import type { Part } from "../src/shared/types";

const part = (id: string, x = 0, y = 0, z = 0): Part => ({
  id,
  key: "brick-1x1",
  color: "#289b74",
  rotation: 0,
  revision: 7,
  position: { x, y, z },
});

describe("movement gesture contract", () => {
  it("preserves off-grid origins and group offsets with a snapped planar displacement", () => {
    const source = [part("a", 1, 3, 5), part("b", 13, 9, 5)];
    const move = captureMove(source, [], 4);
    move.delta = snapMovement({ x: -8.7, y: 22, z: 8.9 });
    expect(movedParts(move).map((p) => p.position)).toEqual([
      { x: -5, y: 3, z: 11 },
      { x: 7, y: 9, z: 11 },
    ]);
    expect(source[0].position).toEqual({ x: 1, y: 3, z: 5 });
  });

  it("constrains elevation to plates and permits sixth-stud precision", () => {
    expect(snapMovement({ x: 23, y: 3.2, z: 17 }, "y")).toEqual({
      x: 0,
      y: 4,
      z: 0,
    });
    expect(snapMovement({ x: 23, y: 3.2, z: 17 }, "y", true)).toEqual({
      x: 0,
      y: 3,
      z: 0,
    });
    expect(snapMovement({ x: 2.7, y: 33, z: 8.2 }, "x", true)).toEqual({
      x: 3,
      y: 0,
      z: 0,
    });
  });

  it("keeps pickup preconditions after another viewer updates the scene", () => {
    const source = part("a");
    const connections = [
      { id: "joint", a: "a", b: "b", ca: "0", cb: "1", revision: 5 },
    ];
    const move = captureMove([source], connections, 4);
    source.revision = 8;
    source.position.x = 30;
    connections[0].revision = 6;
    move.delta = { x: 6, y: 0, z: 0 };
    expect(moveRequest(move)).toEqual({
      action: "edit",
      connections: [{ id: "joint", revision: 5 }],
      changes: [
        { id: "a", expected: 7, rotation: 0, position: { x: 6, y: 0, z: 0 } },
      ],
    });
    expect(captureMove([source], [], 4).connections).toEqual([]);
  });

  it("ignores only the moving sources and rejects occupied space and board limits", () => {
    const source = part("a"),
      neighbour = part("b", 6);
    expect(fitsScene([source], [source, neighbour], ["a"])).toBe(true);
    expect(
      fitsScene(
        [{ ...source, position: neighbour.position }],
        [source, neighbour],
        ["a"],
      ),
    ).toBe(false);
    expect(fitsScene([part("a", 96)], [source], ["a"])).toBe(false);
    expect(fitsScene([source, part("b")], [], [])).toBe(false);
  });
});
