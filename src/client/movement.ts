import { collision, validPart } from "../shared/geometry";
import type { Connection, Edit, Part, Position } from "../shared/types";

export type MoveAxis = "x" | "y" | "z";
export type MoveSnapshot = {
  parts: Part[];
  connections: NonNullable<Edit["connections"]>;
  generation: number;
  delta: Position;
};

// Capture the preconditions at pickup, including an empty connection set.
export function captureMove(
  parts: Part[],
  connections: Connection[],
  generation: number,
): MoveSnapshot {
  const ids = new Set(parts.map((p) => p.id));
  return {
    parts: parts.map((p) => ({ ...p, position: { ...p.position } })),
    connections: connections
      .filter((c) => ids.has(c.a) || ids.has(c.b))
      .map((c) => ({ id: c.id, revision: c.revision })),
    generation,
    delta: { x: 0, y: 0, z: 0 },
  };
}

export function snapMovement(
  delta: Position,
  axis?: MoveAxis,
  fine = false,
): Position {
  return Object.fromEntries(
    (["x", "y", "z"] as const).map((a) => {
      const enabled = axis ? axis === a : a !== "y";
      const step = fine ? 1 : a === "y" ? 2 : 6;
      return [a, enabled ? Math.round(delta[a] / step) * step || 0 : 0];
    }),
  ) as Position;
}

export function movedParts(move: MoveSnapshot): Part[] {
  return move.parts.map((p) => ({
    ...p,
    position: {
      x: p.position.x + move.delta.x,
      y: p.position.y + move.delta.y,
      z: p.position.z + move.delta.z,
    },
  }));
}

export function fitsScene(
  candidates: Part[],
  scene: Part[],
  excluded: string[] = [],
): boolean {
  const ignore = new Set(excluded);
  return candidates.every(
    (p, i) =>
      validPart(p) &&
      !scene.some((other) => !ignore.has(other.id) && collision(p, other)) &&
      !candidates.slice(0, i).some((other) => collision(p, other)),
  );
}

export function moveRequest(
  move: MoveSnapshot,
): Omit<Edit, "operationId" | "generation"> {
  return {
    action: "edit",
    connections: move.connections,
    changes: movedParts(move).map((p) => ({
      id: p.id,
      expected: p.revision,
      position: p.position,
      rotation: p.rotation,
    })),
  };
}
