import assert from "node:assert/strict";
import "./node-websocket";
import { createRealtimeClient } from "@neon/realtime/client";
import { pool } from "../src/server/db";
import type { Viewer } from "../src/shared/types";

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
  const result = await request(token, path, body);
  assert.ok(result.status < 300, `${result.status}: ${result.data.error}`);
  return result.data;
}
const client = createRealtimeClient({
  url: process.env.VITE_NEON_REALTIME_URL!,
});
try {
  const [a, b] = await Promise.all(
    ["Pointer A", "Pointer B"].map(
      async (name) =>
        (await ok("", "/session", { name, color: "#289b74" })).token,
    ),
  );
  const world = await ok(a, "/worlds", {
    title: "Cursor qualification — disposable",
    starter: "empty",
  });
  const [ja, jb] = await Promise.all(
    [a, b].map((token) => ok(token, `/worlds/${world.slug}/join`, {})),
  );
  const sub = client.subscribe<Viewer>(
    await ok(a, `/worlds/${world.id}/live/presence`),
  );
  sub.onChange((snapshot) => {
    if (snapshot.error)
      console.error(
        "Presence subscription:",
        snapshot.status,
        snapshot.error.message,
      );
  });
  await sub.awaitRows(
    (rows) => rows.some((row) => row.id === jb.viewer),
    10000,
  );
  console.log("Presence query admitted.");
  const presence = (
    sequence: number,
    cursor: Viewer["cursor"],
    sample = true,
    token = b,
  ) =>
    request(token, `/worlds/${world.id}/presence`, {
      viewer: jb.viewer,
      sequence,
      generation: 1,
      selection: [],
      preview: null,
      cursor,
      sample,
    });
  const first = { x: 1.25, y: 6.2, z: -3.5 };
  assert.equal((await presence(1, first)).status, 200);
  assert.deepEqual(
    (
      await pool.query("SELECT cursor FROM viewer_sessions WHERE id=$1", [
        jb.viewer,
      ])
    ).rows[0].cursor,
    first,
  );
  await sub.awaitRows(
    (rows) =>
      rows.some((row) => row.id === jb.viewer && row.cursor?.x === first.x),
    10000,
  );
  const latest = { x: 12.75, y: 8, z: -9 };
  await presence(3, latest);
  await presence(2, null);
  await sub.awaitRows(
    (rows) =>
      rows.some((row) => row.id === jb.viewer && row.cursor?.x === latest.x),
    10000,
  );
  const read = async () =>
    (
      await pool.query(
        "SELECT sequence,cursor,cursor_at FROM viewer_sessions WHERE id=$1",
        [jb.viewer],
      )
    ).rows[0];
  const before = await read();
  assert.equal(before.sequence, 3);
  assert.deepEqual(before.cursor, latest);
  await presence(4, null, false);
  const after = await read();
  assert.deepEqual(after.cursor, latest);
  assert.equal(after.cursor_at.valueOf(), before.cursor_at.valueOf());
  assert.equal((await presence(5, { x: 1000, y: 0, z: 0 })).status, 400);
  assert.equal((await presence(6, null, true, a)).status, 410);
  assert.deepEqual((await read()).cursor, latest);
  // A pre-feature client must not overwrite a cursor with an absent field.
  await ok(b, `/worlds/${world.id}/presence`, {
    viewer: jb.viewer,
    sequence: 7,
    generation: 1,
    selection: [],
    preview: null,
    sample: true,
  });
  assert.deepEqual((await read()).cursor, latest);
  await presence(8, null);
  await sub.awaitRows(
    (rows) => rows.some((row) => row.id === jb.viewer && row.cursor === null),
    10000,
  );
  await request(
    b,
    `/worlds/${world.id}/viewers/${jb.viewer}`,
    undefined,
    "DELETE",
  );
  await sub.awaitRows(
    (rows) => !rows.some((row) => row.id === jb.viewer),
    10000,
  );
  assert.equal((await presence(9, first)).status, 410);
  assert.equal(
    (
      await pool.query("SELECT id FROM viewer_sessions WHERE id=$1", [
        jb.viewer,
      ])
    ).rowCount,
    0,
  );
  await request(
    a,
    `/worlds/${world.id}/viewers/${ja.viewer}`,
    undefined,
    "DELETE",
  );
  console.log(
    "PASS cursor delivery over Realtime, ordering, heartbeat timestamp, bounds, viewer ownership, older clients, clear, leave and delayed packets",
  );
} finally {
  client.close();
  await pool.end();
}
