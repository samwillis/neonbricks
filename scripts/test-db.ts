import assert from "node:assert/strict";
import "./node-websocket";
import { randomUUID } from "node:crypto";
import {
  createRealtimeClient,
  type MaterializedLiveQuerySubscription,
} from "@neon/realtime/client";
import { pool } from "../src/server/db";
import { connectorList } from "../src/shared/geometry";
import {
  sceneEntity,
  type SceneRow,
  type Part,
  type Connection,
  type Receipt,
  type Edit,
} from "../src/shared/types";
const base = (
  process.env.TEST_API_URL ||
  process.env.VITE_API_URL ||
  "http://127.0.0.1:3001"
).replace(/\/$/, "");
const trials = Number(process.env.RACE_TRIALS || 100),
  workers = 4;
async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${data.error}`);
  return data;
}
const session = async () =>
  (
    await api<{ token: string }>("", "/session", {
      name: "Database qualification",
      color: "#289b74",
    })
  ).token;
const piece = (key = "brick-1x1", x = 0, y = 0, z = 0, rotation = 0) => ({
  id: randomUUID(),
  key,
  color: "#289b74",
  position: { x, y, z },
  rotation,
});
type Lab = {
  a: string;
  b: string;
  world: string;
  generation: number;
  sub: MaterializedLiveQuerySubscription<SceneRow>;
  client: ReturnType<typeof createRealtimeClient>;
  renew: ReturnType<typeof setInterval>;
};
async function lab(): Promise<Lab> {
  const [a, b] = await Promise.all([session(), session()]);
  const w = await api<{ id: string; slug: string; generation: number }>(
    a,
    "/worlds",
    { title: "Qualification — disposable", starter: "empty" },
  );
  await Promise.all([
    api(a, `/worlds/${w.slug}/join`, {}),
    api(b, `/worlds/${w.slug}/join`, {}),
  ]);
  const sealed = await api<any>(a, `/worlds/${w.id}/live/scene`),
    client = createRealtimeClient({ url: process.env.VITE_NEON_REALTIME_URL! }),
    sub = client.subscribe<SceneRow>(sealed);
  const renew = setInterval(() => {
    void api<any>(a, `/worlds/${w.id}/live/scene`).then((q) => sub.renew(q));
  }, 30_000);
  await sub.awaitRows((rows) => rows.some((r) => r.kind === "world"), 15000);
  return { a, b, world: w.id, generation: w.generation, sub, client, renew };
}
function command(
  l: Lab,
  token: string,
  changes: Edit["changes"],
  connections: Edit["connections"] = [],
  extra: Partial<Edit> = {},
) {
  return api<Receipt>(token, `/worlds/${l.world}/edit`, {
    operationId: randomUUID(),
    generation: l.generation,
    action: "edit",
    changes,
    connections,
    ...extra,
  });
}
async function sync(l: Lab, r: Receipt) {
  assert.ok(r.accepted, r.error);
  if (r.txid) await l.sub.awaitTxId(r.txid, 15000);
}
const edges = (l: Lab) =>
  l.sub
    .getSnapshot()
    .data!.filter((r) => r.kind === "connection")
    .map((r) => sceneEntity(r) as Connection);
async function clean(l: Lab, parts: Part[]) {
  const ids = parts.map((p) => p.id);
  await sync(
    l,
    await command(
      l,
      l.a,
      parts
        .filter((p) => !p.deleted)
        .map((p) => ({ id: p.id, expected: p.revision, deleted: true })),
      edges(l).filter((e) => ids.includes(e.a) || ids.includes(e.b)),
    ),
  );
}
const results: Record<string, number> = {};
const labs: Lab[] = [];
try {
  for (let i = 0; i < workers; i++) labs.push(await lab());
  for (const scenario of [
    "empty collision",
    "rotated bucket boundary",
    "disjoint placements",
    "move versus delete",
    "new adjacent connectors",
    "shared baseplate",
  ]) {
    let next = 0,
      done = 0;
    await Promise.all(
      labs.map(async (l) => {
        while (next < trials) {
          const n = next++;
          let parts: Part[] = [];
          if (scenario === "move versus delete") {
            const p = piece();
            const initial = await command(l, l.a, [p]);
            await sync(l, initial);
            const requests = [
              [{ id: p.id, expected: 1, position: { x: 30, y: 0, z: 0 } }],
              [{ id: p.id, expected: 1, deleted: true }],
            ];
            const rs = await Promise.all([
              command(l, l.a, requests[n % 2]),
              command(l, l.b, requests[1 - (n % 2)]),
            ]);
            assert.equal(rs.filter((r) => r.accepted).length, 1);
            const winner = rs.find((r) => r.accepted)!;
            await sync(l, winner);
            parts = winner.parts!;
          } else if (
            scenario === "new adjacent connectors" ||
            scenario === "shared baseplate"
          ) {
            let lower: any;
            if (scenario === "shared baseplate") {
              lower = piece("plate-4x4");
              await sync(l, await command(l, l.a, [lower]));
            }
            const a = piece(
                "brick-1x1",
                0,
                scenario === "shared baseplate" ? 2 : 0,
              ),
              b = piece(
                "brick-1x1",
                scenario === "shared baseplate" ? 18 : 0,
                scenario === "shared baseplate" ? 2 : 6,
              );
            const rs = await Promise.all([
              command(l, l.a, [n % 2 ? a : b]),
              command(l, l.b, [n % 2 ? b : a]),
            ]);
            for (const r of rs) await sync(l, r);
            assert.equal(
              edges(l).length,
              scenario === "shared baseplate" ? 2 : 1,
            );
            parts = [
              ...rs.flatMap((r) => r.parts!),
              ...(lower ? [{ ...lower, revision: 1 }] : []),
            ];
          } else {
            const boundary = scenario === "rotated bucket boundary",
              disjoint = scenario === "disjoint placements";
            const a = piece(
                boundary ? "brick-1x2" : "brick-1x1",
                boundary ? 23 : 0,
                0,
                0,
                boundary ? 1 : 0,
              ),
              b = piece(
                boundary ? "brick-1x2" : "brick-1x1",
                disjoint ? 48 : boundary ? 23 : 0,
                0,
                0,
                boundary ? 3 : 0,
              );
            const rs = await Promise.all([
              command(l, l.a, [n % 2 ? a : b]),
              command(l, l.b, [n % 2 ? b : a]),
            ]);
            assert.equal(rs.filter((r) => r.accepted).length, disjoint ? 2 : 1);
            for (const r of rs.filter((r) => r.accepted)) await sync(l, r);
            parts = rs.flatMap((r) => r.parts || []);
          }
          if (parts.some((p) => !p.deleted)) await clean(l, parts);
          if (++done % 25 === 0) console.log(`${scenario}: ${done}/${trials}`);
        }
      }),
    );
    results[scenario] = done;
    console.log("PASS", scenario, done);
  }
  const mechanical = labs[1];
  for (let rotation = 0; rotation < 4; rotation++)
    for (const key of [
      "beam-3",
      "bearing",
      "gear-12",
      "gear-20",
      "wheel",
      "hub",
      "crank",
    ]) {
      const receiver = piece(key, 12, 12, 12, rotation),
        axle = piece("axle-4", 0, 0, 0, rotation),
        hole = connectorList({ ...receiver, revision: 1 }).find(
          (c) => c.type === "hole",
        )!,
        shaft = connectorList({ ...axle, revision: 1 }).find(
          (c) => c.type === "shaft",
        )!;
      axle.position = {
        x: hole.at.x - shaft.at.x,
        y: hole.at.y - shaft.at.y,
        z: hole.at.z - shaft.at.z,
      };
      const assembled = await command(mechanical, mechanical.a, [
        receiver,
        axle,
      ]);
      await sync(mechanical, assembled);
      assert.equal(
        edges(mechanical).length,
        1,
        `${key}/${rotation}: missing shaft connection`,
      );
      const offset = await command(
        mechanical,
        mechanical.b,
        [
          {
            id: axle.id,
            expected: 1,
            position: { ...axle.position, y: axle.position.y + 2 },
          },
        ],
        edges(mechanical),
      );
      assert.equal(
        offset.accepted,
        false,
        `${key}/${rotation}: shaft pierced body`,
      );
      assert.equal(
        edges(mechanical).length,
        1,
        "Rejected move changed topology",
      );
      await clean(mechanical, assembled.parts!);
    }
  console.log(
    "PASS 28 mechanical shaft fits, connection persistence and rejected offset moves",
  );
  const l = labs[0],
    p = piece(),
    placeId = randomUUID();
  const original = {
    operationId: placeId,
    generation: 1,
    action: "edit" as const,
    changes: [p],
  };
  const placed = await api<Receipt>(l.a, `/worlds/${l.world}/edit`, original);
  await sync(l, placed);
  assert.deepEqual(await api(l.a, `/worlds/${l.world}/edit`, original), placed);
  const recolorId = randomUUID();
  await sync(
    l,
    await command(l, l.a, [{ id: p.id, expected: 1, color: "#d9594e" }], [], {
      operationId: recolorId,
    }),
  );
  for (const [action, target] of [
    ["undo", recolorId],
    ["redo", recolorId],
    ["undo", recolorId],
    ["undo", placeId],
    ["redo", placeId],
    ["redo", recolorId],
  ] as const)
    await sync(
      l,
      await command(l, l.a, undefined, undefined, { action, target }),
    );
  const current = l.sub.getSnapshot().data!.find((r) => r.id === p.id)!;
  await sync(
    l,
    await command(l, l.b, [
      { id: p.id, expected: current.revision, color: "#72a6c8" },
    ]),
  );
  const conflict = await command(l, l.a, undefined, undefined, {
    action: "undo",
    target: recolorId,
  });
  assert.equal(conflict.accepted, false);
  const invalid = {
    operationId: randomUUID(),
    generation: 1,
    action: "edit" as const,
    changes: [piece("brick-1x1", 96)],
  };
  const rejected = await api<Receipt>(l.a, `/worlds/${l.world}/edit`, invalid);
  assert.equal(rejected.accepted, false);
  assert.deepEqual(
    await api(l.a, `/worlds/${l.world}/edit`, invalid),
    rejected,
  );
  const reset = await api<{ generation: number }>(
    l.a,
    `/worlds/${l.world}/reset`,
    { generation: 1, starter: "empty" },
  );
  assert.equal(reset.generation, 2);
  await l.sub.awaitRows(
    (rows) =>
      rows.find((r) => r.kind === "world")?.generation === 2 &&
      rows.filter((r) => r.kind !== "world").length === 0,
    15000,
  );
  assert.deepEqual(await api(l.a, `/worlds/${l.world}/edit`, original), placed);
  assert.equal((await command(l, l.a, [piece()])).accepted, false);
  console.log(
    "PASS receipts, chained compensation, third-party revision, coherent reset and old-generation replay",
  );
  // These predicates audit all test-created rooms, not the shared workshop.
  const bad = await pool.query(
    "SELECT count(*)::int AS n FROM connector_slot_claims c LEFT JOIN part_connections e ON e.id=c.connection WHERE c.world=ANY($1::uuid[]) AND (e.id IS NULL OR e.deleted<>0)",
    [labs.map((l) => l.world)],
  );
  assert.equal(bad.rows[0].n, 0);
  console.log(
    JSON.stringify(
      { api: base, trials: results, extraChecks: "PASS" },
      null,
      2,
    ),
  );
} finally {
  labs.forEach((l) => {
    clearInterval(l.renew);
    l.client.close();
  });
  await pool.end();
}
