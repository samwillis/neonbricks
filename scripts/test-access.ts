import assert from "node:assert/strict";
import "./node-websocket";
import { randomUUID } from "node:crypto";
import {
  createRealtimeClient,
  type SealedLiveQuery,
} from "@neon/realtime/client";
import { pool } from "../src/server/db";
import type { SceneRow, Receipt } from "../src/shared/types";
const base = (process.env.TEST_API_URL || process.env.VITE_API_URL!).replace(
  /\/$/,
  "",
);
async function request(
  token: string,
  path: string,
  body?: unknown,
  method?: string,
) {
  const response = await fetch(`${base}/api${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(token: string, path: string, body?: unknown) {
  const r = await request(token, path, body);
  assert.ok(r.status < 300, `${r.status}: ${r.data.error}`);
  return r.data;
}
const session = async () =>
  (await ok("", "/session", { name: "Access qualification", color: "#289b74" }))
    .token;
const p = () => ({
  id: randomUUID(),
  key: "brick-1x1",
  color: "#289b74",
  position: { x: 0, y: 0, z: 0 },
  rotation: 0,
});
const clients: ReturnType<typeof createRealtimeClient>[] = [],
  timers: ReturnType<typeof setInterval>[] = [];
try {
  const [a, b] = await Promise.all([session(), session()]);
  const world = await ok(a, "/worlds", {
    title: "Access qualification — disposable",
    starter: "empty",
  });
  const [ja, jb] = await Promise.all([
    ok(a, `/worlds/${world.slug}/join`, {}),
    ok(b, `/worlds/${world.slug}/join`, {}),
  ]);
  const client = createRealtimeClient({
    url: process.env.VITE_NEON_REALTIME_URL!,
  });
  clients.push(client);
  const subscriptions = [];
  for (const kind of ["scene", "presence", "history"]) {
    const seal = () => ok(b, `/worlds/${world.id}/live/${kind}`),
      sub = client.subscribe(await seal());
    await sub.awaitRows((r) => r.length > 0, 10000);
    subscriptions.push(sub);
    timers.push(
      setInterval(() => {
        void seal()
          .then((q) => sub.renew(q))
          .catch(() => {});
      }, 35000),
    );
  }
  const edit = (token: string, generation: number, part: any) =>
    ok(token, `/worlds/${world.id}/edit`, {
      operationId: randomUUID(),
      generation,
      action: "edit",
      changes: [part],
      connections: [],
    });
  const first = p(),
    id = randomUUID(),
    original = {
      operationId: id,
      generation: 1,
      action: "edit",
      changes: [first],
      connections: [],
    };
  const accepted = await ok(a, `/worlds/${world.id}/edit`, original);
  assert.ok(accepted.accepted);
  assert.equal(
    (
      await request(a, `/worlds/${world.id}/edit`, {
        ...original,
        changes: [{ ...first, color: "#d9594e" }],
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(b, `/worlds/${world.id}/operations/${id}`)).status,
    404,
  );
  const bulk = [p(), p()].map((x) => ({
    ...x,
    position: { x: 30, y: 0, z: 0 },
  }));
  assert.equal((await edit(a, 1, bulk[0])).accepted, true);
  const invalid = await ok(a, `/worlds/${world.id}/edit`, {
    operationId: randomUUID(),
    generation: 1,
    action: "edit",
    changes: [p(), p()].map((x) => ({ ...x, position: { x: 60, y: 0, z: 0 } })),
    connections: [],
  });
  assert.equal(invalid.accepted, false);
  const presence = (seq: number, preview: any, sample = true) =>
    request(b, `/worlds/${world.id}/presence`, {
      viewer: jb.viewer,
      sequence: seq,
      generation: 1,
      selection: [],
      preview,
      sample,
    });
  await presence(1, {
    key: "brick-1x1",
    color: "#289b74",
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
  });
  await presence(3, {
    key: "brick-1x1",
    color: "#d9594e",
    position: { x: 12, y: 0, z: 0 },
    rotation: 0,
  });
  await presence(2, null);
  const before = await pool.query(
    "SELECT sequence,preview,preview_at FROM viewer_sessions WHERE id=$1",
    [jb.viewer],
  );
  assert.equal(before.rows[0].sequence, 3);
  assert.equal(before.rows[0].preview.position.x, 12);
  await presence(4, null, false);
  const after = await pool.query(
    "SELECT preview_at FROM viewer_sessions WHERE id=$1",
    [jb.viewer],
  );
  assert.equal(
    after.rows[0].preview_at.valueOf(),
    before.rows[0].preview_at.valueOf(),
  );
  await request(
    b,
    `/worlds/${world.id}/viewers/${jb.viewer}`,
    undefined,
    "DELETE",
  );
  assert.equal((await presence(5, null)).status, 410);
  assert.equal(
    (
      await pool.query("SELECT id FROM viewer_sessions WHERE id=$1", [
        jb.viewer,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await request("", "/cleanup", {})).status, 401);
  await pool.query(
    "UPDATE world_memberships SET role='viewer' WHERE world=$1 AND guest=$2",
    [world.id, jb.guest],
  );
  assert.equal(
    (
      await request(b, `/worlds/${world.id}/edit`, {
        operationId: randomUUID(),
        generation: 1,
        action: "edit",
        changes: [p()],
      })
    ).status,
    403,
  );
  await pool.query(
    "UPDATE world_memberships SET active=0 WHERE world=$1 AND guest=$2",
    [world.id, jb.guest],
  );
  for (const sub of subscriptions)
    await sub.awaitRows((rows) => rows.length === 0, 10000);
  assert.equal(
    (await request(b, `/worlds/${world.slug}/join`, {})).status,
    403,
  );
  console.log(
    "PASS capability admission, dynamic membership withdrawal, roles, foreign receipts, presence ordering, leave, cleanup authentication, bulk rollback",
  );
  let generation = 1;
  for (let i = 0; i < 100; i++) {
    const changes = [
      {
        ...p(),
        position: {
          x: 36 + (i % 4) * 12,
          y: 0,
          z: 36 + (Math.floor(i / 4) % 4) * 12,
        },
      },
    ];
    const [closed, edited] = await Promise.all([
      ok(a, `/worlds/${world.id}/lifecycle`, { generation, status: "closed" }),
      request(a, `/worlds/${world.id}/edit`, {
        operationId: randomUUID(),
        generation,
        action: "edit",
        changes,
        connections: [],
      }),
    ]);
    assert.equal(closed.generation, generation + 1);
    assert.ok(edited.status === 410 || edited.status === 200);
    assert.equal(
      (
        await request(a, `/worlds/${world.id}/edit`, {
          operationId: randomUUID(),
          generation: generation + 1,
          action: "edit",
          changes: [p()],
        })
      ).status,
      410,
    );
    generation = (
      await ok(a, `/worlds/${world.id}/lifecycle`, {
        generation: generation + 1,
        status: "open",
      })
    ).generation;
    generation = (
      await ok(a, `/worlds/${world.id}/reset`, { generation, starter: "empty" })
    ).generation;
  }
  console.log("PASS 100 closure versus edit trials and creator reopen/reset");
  const c = await session(),
    jc = await ok(c, `/worlds/${world.slug}/join`, {}),
    liveClient = createRealtimeClient({
      url: process.env.VITE_NEON_REALTIME_URL!,
    });
  clients.push(liveClient);
  const cap = await ok(c, `/worlds/${world.id}/live/scene`),
    sub = liveClient.subscribe<SceneRow>(cap);
  await sub.awaitRows((rows) => rows.length > 0, 10000);
  await pool.query(
    "UPDATE guest_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT session FROM viewer_sessions WHERE id=$1)",
    [jc.viewer],
  );
  assert.equal((await request(c, "/session/renew", {})).status, 401);
  assert.equal(
    (await request(c, `/worlds/${world.id}/live/scene`)).status,
    401,
  );
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, cap.expiresAt - Date.now() + 1500)),
  );
  assert.notEqual(sub.getSnapshot().status, "live");
  console.log(
    "PASS expired session denies renewal; existing capability ceases to be live at its 60-second boundary",
  );
  const d = await session(),
    jd = await ok(d, `/worlds/${world.slug}/join`, {}),
    sealed = await ok(d, `/worlds/${world.id}/live/scene`),
    ds = liveClient.subscribe<SceneRow>(sealed);
  await ds.awaitRows((rows) => rows.length > 0, 10000);
  await ok(d, "/session/revoke", {});
  await ds.awaitRows((rows) => rows.length === 0, 10000);
  assert.equal((await request(d, "/session/renew", {})).status, 401);
  console.log("PASS committed session revocation withdraws live rows");
} finally {
  timers.forEach(clearInterval);
  clients.forEach((c) => c.close());
  await pool.end();
}
