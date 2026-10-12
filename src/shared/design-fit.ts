import { compileBlueprint, type CompiledBlueprint } from "./blueprint";
import { expandDesign, presentationTurn, type Design } from "./design";
import { bounds, connectorList } from "./geometry";

export type DesignAdjustment = { rows: string[]; shift: number[] };
// Correct only small missed stud placements. Move an entire disconnected
// component, preserving its shape, repeats and colours. Every candidate goes
// through full validation; collisions and large design errors need inference.
export function snapDesign(
  initial: Design,
  checked = compileBlueprint(initial),
) {
  let design = initial;
  let compiled: CompiledBlueprint = checked;
  const adjustments: DesignAdjustment[] = [];
  let evaluations = 0;
  while (
    compiled.issues.length &&
    compiled.issues.every((i) => i.code === "unattached") &&
    evaluations < 36
  ) {
    const missing = new Set(compiled.issues.flatMap((i) => i.parts));
    const graph = new Map(compiled.parts.map((p) => [p.id, new Set<string>()]));
    for (const edge of compiled.edges) {
      graph.get(edge.a)!.add(edge.b);
      graph.get(edge.b)!.add(edge.a);
    }
    const owner = new Map<string, string>();
    const members = new Map<string, string[]>();
    for (const row of design.pieces) {
      const ids = expandDesign({ ...design, pieces: [row] }).parts.map(
        (p) => p.id,
      );
      members.set(row.id, ids);
      ids.forEach((id) => owner.set(id, row.id));
    }
    const roots = compiled.parts
      .filter((p) => missing.has(p.id))
      .sort((a, b) => bounds(a).miny - bounds(b).miny);
    let improved = false;
    const visited = new Set<string>();
    for (const root of roots) {
      if (visited.has(root.id)) continue;
      const group = new Set([root.id]);
      const queue = [root.id];
      for (let i = 0; i < queue.length; i++)
        for (const id of graph.get(queue[i])!)
          if (!group.has(id)) {
            group.add(id);
            queue.push(id);
          }
      group.forEach((id) => visited.add(id));
      const rows = new Set([...group].map((id) => owner.get(id)!));
      if ([...rows].some((id) => members.get(id)!.some((p) => !group.has(p))))
        continue;
      const sockets = connectorList(root).filter((c) => c.type === "socket");
      const offsets = new Map<string, number[]>();
      for (const target of compiled.parts) {
        if (group.has(target.id) || missing.has(target.id)) continue;
        for (const stud of connectorList(target).filter(
          (c) => c.type === "stud",
        ))
          for (const socket of sockets) {
            const d = [
              stud.at.x - socket.at.x,
              stud.at.y - socket.at.y,
              stud.at.z - socket.at.z,
            ];
            if (
              Math.hypot(d[0], d[2]) > 6 ||
              Math.abs(d[1]) > 2 ||
              d.every((v) => v === 0)
            )
              continue;
            offsets.set(d.join(","), d);
          }
      }
      const candidates = [...offsets.values()]
        .sort(
          (a, b) =>
            a.reduce((s, v) => s + v * v, 0) - b.reduce((s, v) => s + v * v, 0),
        )
        .slice(0, 12);
      for (const delta of candidates) {
        if (++evaluations > 36) break;
        const turn = presentationTurn(design.front);
        const [x, y, z] = delta;
        const local =
          turn === 1
            ? [z, y, -x]
            : turn === 2
              ? [-x, y, -z]
              : turn === 3
                ? [-z, y, x]
                : delta;
        const shift = [local[0] / 6, local[1] / 2, local[2] / 6].map(
          (v) => v || 0,
        );
        const next = {
          ...design,
          pieces: design.pieces.map((row) =>
            rows.has(row.id)
              ? { ...row, at: row.at.map((v, i) => v + shift[i]) }
              : row,
          ),
        };
        const result = compileBlueprint(next);
        if (
          result.issues.length >= compiled.issues.length ||
          result.issues.some((i) => i.code !== "unattached")
        )
          continue;
        design = next;
        compiled = result;
        adjustments.push({ rows: [...rows], shift });
        improved = true;
        break;
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return { design, compiled, adjustments };
}
