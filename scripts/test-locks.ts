import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/server/db";
import { bucketKeys } from "../src/shared/geometry";
import type { Part } from "../src/shared/types";
const base = (process.env.TEST_API_URL || process.env.VITE_API_URL!).replace(
  /\/$/,
  "",
);
async function request(token: string, path: string, body: any) {
  const r = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
const c = await pool.connect();
try {
  const { data: s } = await request("", "/session", {
      name: "Lock qualification",
      color: "#289b74",
    }),
    { data: w } = await request(s.token, "/worlds", {
      title: "Lock qualification — disposable",
      starter: "empty",
    });
  await request(s.token, `/worlds/${w.slug}/join`, {});
  const p: Part = {
    id: randomUUID(),
    key: "brick-1x1",
    color: "#289b74",
    position: { x: -78, y: 0, z: -78 },
    rotation: 0,
    revision: 1,
  };
  const keys = bucketKeys([p]).map((k) => k.split(",").map(Number));
  await c.query("BEGIN");
  await c.query(
    "SELECT b.x FROM spatial_buckets b JOIN unnest($2::int[],$3::int[],$4::int[]) AS k(x,y,z) USING(x,y,z) WHERE b.world=$1 ORDER BY b.x,b.y,b.z FOR UPDATE OF b",
    [w.id, keys.map((k) => k[0]), keys.map((k) => k[1]), keys.map((k) => k[2])],
  );
  const independent = {
    operationId: randomUUID(),
    generation: 1,
    action: "edit",
    changes: [{ ...p, id: randomUUID(), position: { x: 72, y: 0, z: 72 } }],
  };
  const start = performance.now(),
    disjoint = await request(s.token, `/worlds/${w.id}/edit`, independent);
  assert.equal(disjoint.status, 200);
  assert.equal(disjoint.data.accepted, true);
  assert.ok(performance.now() - start < 2500);
  const overlapping = {
      operationId: randomUUID(),
      generation: 1,
      action: "edit",
      changes: [p],
    },
    blocked = await request(s.token, `/worlds/${w.id}/edit`, overlapping);
  assert.equal(blocked.status, 503);
  await c.query("ROLLBACK");
  const retried = await request(s.token, `/worlds/${w.id}/edit`, overlapping);
  assert.equal(retried.data.accepted, true);
  console.log(
    "PASS a held spatial neighbourhood allows a disjoint edit to commit, blocks an intersecting edit, and accepts the identical operation after release",
  );
} finally {
  await c.query("ROLLBACK").catch(() => {});
  c.release();
  await pool.end();
}
