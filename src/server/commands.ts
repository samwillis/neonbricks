import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  type Part,
  type Connection,
  type Edit,
  type Receipt,
  CATALOGUE_VERSION,
} from "../shared/types";
import {
  bounds,
  bucketKeys,
  enclosing,
  collision,
  validPart,
  connectorList,
  mating,
} from "../shared/geometry";
import { transaction } from "./db";
import { DomainError, hash, lockAccess, type Identity } from "./auth";
import { partFromRow, insertPart } from "./worlds";
type Entry = {
  id: string;
  expected: Part[];
  connections: Connection[];
  geometry: boolean;
  bridgeBefore: (Part | null)[];
  bridgeConnections: Connection[];
};
type History = { undo: Entry[]; redo: Entry[]; generation: number };
const connFromRow = (r: Record<string, any>): Connection => ({
  id: r.id,
  a: r.a,
  b: r.b,
  ca: r.ca,
  cb: r.cb,
  revision: r.revision,
});
const sortedConnections = (cs: { id: string; revision: number }[]) =>
  JSON.stringify(
    cs
      .map((c) => ({ id: c.id, revision: c.revision }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
async function incident(c: PoolClient, world: string, ids: string[]) {
  const { rows } = await c.query(
    "SELECT * FROM part_connections WHERE world=$1 AND deleted=0 AND (a=ANY($2::uuid[]) OR b=ANY($2::uuid[])) ORDER BY id",
    [world, ids],
  );
  return rows.map(connFromRow);
}
export async function reconnectParts(
  c: PoolClient,
  world: string,
  changed: Part[],
  candidates: Part[],
  old: Connection[],
) {
  if (old.length) {
    await c.query(
      "DELETE FROM connector_slot_claims WHERE connection=ANY($1::uuid[])",
      [old.map((c) => c.id)],
    );
    await c.query(
      "UPDATE part_connections SET deleted=1,revision=revision+1 WHERE id=ANY($1::uuid[])",
      [old.map((c) => c.id)],
    );
  }
  const seen = new Set<string>();
  const after: Connection[] = [];
  for (const p of changed.filter((p) => !p.deleted))
    for (const n of candidates.filter((n) => !n.deleted && n.id !== p.id)) {
      const aa = connectorList(p),
        bb = connectorList(n);
      for (const a of aa)
        for (const b of bb)
          if (mating(a, b)) {
            const [pa, pb, ca, cb] = p.id < n.id ? [p, n, a, b] : [n, p, b, a];
            const k = `${pa.id}/${pb.id}/${ca.id}/${cb.id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const { rows } = await c.query(
              "INSERT INTO part_connections(id,world,a,b,ca,cb,revision) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(world,a,b,ca,cb) DO UPDATE SET deleted=0,revision=part_connections.revision+1 RETURNING *",
              [randomUUID(), world, pa.id, pb.id, ca.id, cb.id],
            );
            const edge = connFromRow(rows[0]);
            after.push(edge);
            for (const [part, connector] of [
              [pa, ca],
              [pb, cb],
            ] as const)
              if (connector.exclusive)
                await c.query(
                  "INSERT INTO connector_slot_claims(world,part,slot,connection) VALUES($1,$2,$3,$4)",
                  [world, part.id, connector.id, edge.id],
                );
          }
    }
  return after;
}
async function applyChanges(
  c: PoolClient,
  world: string,
  changes: NonNullable<Edit["changes"]>,
  expectedConnections: { id: string; revision: number }[] | undefined,
  compensation = false,
) {
  if (
    !changes.length ||
    changes.length > 100 ||
    new Set(changes.map((x) => x.id)).size !== changes.length
  )
    throw new DomainError("Select between one and 100 distinct parts");
  const ids = changes.map((x) => x.id),
    prelim = await c.query(
      "SELECT * FROM part_instances WHERE world=$1 AND id=ANY($2::uuid[])",
      [world, ids],
    );
  const oldMap = new Map<string, Part>(
    prelim.rows.map((r) => [r.id, partFromRow(r)]),
  );
  const before: (Part | null)[] = changes.map(
    (change) => oldMap.get(change.id) || null,
  );
  const after = changes.map((change) => {
    const old = oldMap.get(change.id);
    if (old) {
      if (change.expected !== old.revision || (!compensation && old.deleted))
        throw new DomainError("That part has changed. Try again.");
    } else if (change.expected !== undefined)
      throw new DomainError("That part no longer exists");
    const p: Part = {
      id: change.id,
      key: change.key || old?.key || "",
      color: change.color || old?.color || "",
      position: change.position || old?.position || { x: NaN, y: NaN, z: NaN },
      rotation: change.rotation ?? old?.rotation ?? 0,
      revision: (old?.revision || 0) + 1,
      deleted: change.deleted ?? false,
    };
    if (!validPart(p))
      throw new DomainError("Invalid part or outside the workbench");
    return p;
  });
  const geometric = after.some(
    (p, i) =>
      !before[i] ||
      before[i]!.key !== p.key ||
      before[i]!.rotation !== p.rotation ||
      JSON.stringify(before[i]!.position) !== JSON.stringify(p.position) ||
      !!before[i]!.deleted !== !!p.deleted,
  );
  const footprint = [...before.filter((p): p is Part => !!p), ...after];
  if (geometric) {
    const keys = bucketKeys(footprint).map((k) => k.split(",").map(Number));
    const locked = await c.query(
      "SELECT b.x,b.y,b.z FROM spatial_buckets b JOIN unnest($2::int[],$3::int[],$4::int[]) AS k(x,y,z) USING(x,y,z) WHERE b.world=$1 ORDER BY b.x,b.y,b.z FOR UPDATE OF b",
      [
        world,
        keys.map((k) => k[0]),
        keys.map((k) => k[1]),
        keys.map((k) => k[2]),
      ],
    );
    if (locked.rowCount !== keys.length)
      throw new DomainError("Outside the workbench");
  }
  const locked = await c.query(
    "SELECT * FROM part_instances WHERE world=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
    [world, ids],
  );
  for (const row of locked.rows) {
    const original = oldMap.get(row.id);
    if (!original || original.revision !== row.revision)
      throw new DomainError("That part has changed. Try again.");
  }
  if (locked.rows.length !== prelim.rows.length)
    throw new DomainError("That part has changed. Try again.");
  const beforeConnections = await incident(c, world, ids);
  if (geometric && before.some((p) => !!p && !p.deleted)) {
    if (
      expectedConnections === undefined ||
      sortedConnections(expectedConnections) !==
        sortedConnections(beforeConnections)
    )
      throw new DomainError("Connections changed. Refresh the selection.");
  }
  let candidates: Part[] = [];
  if (geometric) {
    // A new READ COMMITTED statement after bucket waits sees the winner's commit.
    const b = enclosing(footprint);
    const result = await c.query(
      "SELECT * FROM part_instances WHERE world=$1 AND deleted=0 AND minx<=$2 AND maxx>=$3 AND miny<=$4 AND maxy>=$5 AND minz<=$6 AND maxz>=$7 AND NOT(id=ANY($8::uuid[]))",
      [world, b.maxx, b.minx, b.maxy, b.miny, b.maxz, b.minz, ids],
    );
    candidates = result.rows.map(partFromRow);
    const active = after.filter((p) => !p.deleted);
    for (let i = 0; i < active.length; i++) {
      for (const other of candidates)
        if (collision(active[i], other))
          throw new DomainError("That space is occupied");
      for (let j = 0; j < i; j++)
        if (collision(active[i], active[j]))
          throw new DomainError("Selected parts overlap");
    }
  }
  for (const [i, p] of after.entries()) {
    if (!before[i]) await insertPart(c, world, p);
    else {
      const b = bounds(p);
      await c.query(
        "UPDATE part_instances SET key=$3,color=$4,x=$5,y=$6,z=$7,rotation=$8,revision=$9,deleted=$10,minx=$11,miny=$12,minz=$13,maxx=$14,maxy=$15,maxz=$16 WHERE world=$1 AND id=$2",
        [
          world,
          p.id,
          p.key,
          p.color,
          p.position.x,
          p.position.y,
          p.position.z,
          p.rotation,
          p.revision,
          p.deleted ? 1 : 0,
          b.minx,
          b.miny,
          b.minz,
          b.maxx,
          b.maxy,
          b.maxz,
        ],
      );
    }
  }
  const afterConnections = geometric
    ? await reconnectParts(
        c,
        world,
        after,
        [...candidates, ...after],
        beforeConnections,
      )
    : beforeConnections;
  return { before, after, beforeConnections, afterConnections, geometric };
}
function rebase(
  entry: Entry | undefined,
  originalBefore: (Part | null)[],
  now: Part[],
  beforeConnections: Connection[],
  afterConnections: Connection[],
) {
  if (!entry) return;
  for (const expected of entry.expected) {
    const before = originalBefore.find((p) => p?.id === expected.id);
    const current = now.find((p) => p.id === expected.id);
    if (
      before &&
      current &&
      before.revision === expected.revision &&
      !!before.deleted === !!expected.deleted
    )
      Object.assign(expected, current);
  }
  if (entry.geometry)
    for (const expected of entry.connections) {
      const before = beforeConnections.find((c) => c.id === expected.id),
        current = afterConnections.find((c) => c.id === expected.id);
      if (before && current && before.revision === expected.revision)
        Object.assign(expected, current);
    }
}
export async function execute(
  a: Identity,
  world: string,
  request: Edit,
): Promise<Receipt> {
  return transaction(async (c) => {
    const w = await lockAccess(c, a, world),
      digest = hash(canonical(request));
    const inserted = await c.query(
      "INSERT INTO build_operations(world,guest,id,generation,digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *,pg_current_xact_id()::text AS txid",
      [world, a.guest, request.operationId, request.generation, digest],
    );
    const { rows: ops } = inserted.rowCount
      ? inserted
      : await c.query(
          "SELECT * FROM build_operations WHERE world=$1 AND guest=$2 AND id=$3 FOR UPDATE",
          [world, a.guest, request.operationId],
        );
    if (ops[0].digest !== digest)
      throw new DomainError("Operation ID reused with different changes");
    if (!inserted.rowCount) {
      if (!ops[0].receipt) throw new Error("Incomplete operation record");
      return ops[0].receipt;
    }
    const historyRow = await c.query(
      "SELECT * FROM guest_world_history WHERE world=$1 AND guest=$2 FOR UPDATE",
      [world, a.guest],
    );
    const h: History = historyRow.rows[0] || {
      undo: [],
      redo: [],
      generation: w.generation,
    };
    if (h.generation !== w.generation) {
      h.undo = [];
      h.redo = [];
      h.generation = w.generation;
    }
    await c.query("SAVEPOINT edit");
    try {
      if (request.generation !== w.generation || w.status !== "open")
        throw new DomainError(
          "The workshop was reset or closed. Refresh your preview.",
        );
      if (w.catalogue !== CATALOGUE_VERSION)
        throw new DomainError("Catalogue version unavailable");
      let changes = request.changes,
        expectedConnections = request.connections,
        entry: Entry | undefined,
        original: any;
      if (request.action !== "edit") {
        const stack = request.action === "undo" ? h.undo : h.redo;
        entry = stack.at(-1);
        if (!entry || entry.id !== request.target)
          throw new DomainError("Undo history changed. Try again.");
        const { rows } = await c.query(
          "SELECT * FROM build_operations WHERE world=$1 AND guest=$2 AND id=$3",
          [world, a.guest, entry.id],
        );
        original = rows[0];
        const desired: (Part | null)[] =
          request.action === "undo" ? original.before : original.after;
        changes = entry.expected.map((current) => {
          const p = desired.find((p) => p?.id === current.id);
          return p
            ? { ...p, expected: current.revision }
            : { id: current.id, expected: current.revision, deleted: true };
        });
        expectedConnections = entry.connections;
      }
      if (!changes) throw new DomainError("No parts selected");
      const result = await applyChanges(
        c,
        world,
        changes,
        expectedConnections,
        request.action !== "edit",
      );
      if (request.action === "edit") {
        h.undo.push({
          id: request.operationId,
          expected: result.after,
          connections: result.afterConnections,
          geometry: result.geometric,
          bridgeBefore: result.before,
          bridgeConnections: result.beforeConnections,
        });
        h.undo = h.undo.slice(-100);
        h.redo = [];
      } else {
        const stack = request.action === "undo" ? h.undo : h.redo,
          other = request.action === "undo" ? h.redo : h.undo;
        stack.pop();
        other.push({
          id: entry!.id,
          expected: result.after,
          connections: result.afterConnections,
          geometry: entry!.geometry,
          bridgeBefore: result.before,
          bridgeConnections: result.beforeConnections,
        });
        // Carry the effective revision bridge through repeated compensation,
        // including intervening actions on unrelated parts. Immutable receipts
        // remain unchanged; a third party's revision never matches this bridge.
        for (const remaining of stack)
          rebase(
            remaining,
            entry!.bridgeBefore || original.before,
            result.after,
            entry!.bridgeConnections || original.before_connections,
            result.afterConnections,
          );
      }
      await c.query(
        "UPDATE guest_world_history SET generation=$3,undo=$4,redo=$5 WHERE world=$1 AND guest=$2",
        [
          world,
          a.guest,
          w.generation,
          JSON.stringify(h.undo),
          JSON.stringify(h.redo),
        ],
      );
      const receipt: Receipt = {
        accepted: true,
        operationId: request.operationId,
        generation: w.generation,
        txid: ops[0].txid,
        parts: result.after,
        history: {
          undo: h.undo.at(-1)?.id || null,
          redo: h.redo.at(-1)?.id || null,
        },
      };
      await c.query(
        "UPDATE build_operations SET receipt=$4,before=$5,after=$6,before_connections=$7,after_connections=$8 WHERE world=$1 AND guest=$2 AND id=$3",
        [
          world,
          a.guest,
          request.operationId,
          JSON.stringify(receipt),
          JSON.stringify(result.before),
          JSON.stringify(result.after),
          JSON.stringify(result.beforeConnections),
          JSON.stringify(result.afterConnections),
        ],
      );
      return receipt;
    } catch (error) {
      if (
        !(error instanceof DomainError) &&
        !["23505", "23503"].includes((error as { code?: string }).code || "")
      )
        throw error;
      await c.query("ROLLBACK TO SAVEPOINT edit");
      const receipt: Receipt = {
        accepted: false,
        operationId: request.operationId,
        generation: request.generation,
        error:
          error instanceof DomainError
            ? error.message
            : "This part or connector is already in use",
      };
      await c.query(
        "UPDATE build_operations SET receipt=$4 WHERE world=$1 AND guest=$2 AND id=$3",
        [world, a.guest, request.operationId, JSON.stringify(receipt)],
      );
      return receipt;
    }
  });
}
