import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/server/db";
import { newSession, authenticate } from "../src/server/auth";
import { createWorld, joinWorld } from "../src/server/worlds";
import { trustedRealtime, memberQuery, historyQuery } from "../src/server/live";
import {
  conversationQuery,
  createGeneration,
  recordDrawing,
  runGeneration,
  expireGenerations,
} from "../src/server/ai";
import { compileBlueprint } from "../src/shared/blueprint";
import { writeFile, mkdir } from "node:fs/promises";

// Real Postgres and Realtime, disposable fixtures, no Gateway calls. Only
// production requests carry the persisted session used by scheduled dispatch.
const rt = trustedRealtime(true);
const jobs: string[] = [];
let world: string | undefined;
const guests: string[] = [];
const fixture = {
  version: 1,
  catalogue: "workshop-1",
  title: "Realtime fixture",
  summary: "A green brick.",
  parts: [
    {
      id: "brick",
      part: "brick-2x2",
      colour: "jade",
      turn: 0,
      at: [0, 0, 0],
      attach: null,
    },
  ],
};
try {
  const user = await newSession("Realtime qualification", "#289b74");
  guests.push(user.guest);
  const a = await authenticate(`Bearer ${user.token}`);
  const w = await createWorld(
    "Realtime qualification — disposable",
    a.guest,
    false,
  );
  world = w.id;
  await joinWorld(a, w.slug);
  const member = await rt.subscribe(memberQuery(world!, a));
  await member.awaitRows((rows) => rows[0]?.role === "editor", 20000);
  console.log("Live member connected");
  await pool.query(
    "UPDATE guests SET name='Renamed in another tab',color='#edbc46' WHERE id=$1",
    [a.guest],
  );
  await member.awaitRows(
    (rows) =>
      rows[0]?.name === "Renamed in another tab" &&
      rows[0]?.color === "#edbc46",
    20000,
  );
  await pool.query(
    "UPDATE world_memberships SET role='viewer' WHERE world=$1 AND guest=$2",
    [world, a.guest],
  );
  await member.awaitRows((rows) => rows[0]?.role === "viewer", 20000);
  await pool.query(
    "UPDATE world_memberships SET role='editor' WHERE world=$1 AND guest=$2",
    [world, a.guest],
  );
  await member.awaitRows((rows) => rows[0]?.role === "editor", 20000);
  const history = await rt.subscribe(historyQuery(world!, a));
  await history.awaitRows((rows) => rows[0]?.generation === 1, 20000);
  await pool.query(
    "DELETE FROM guest_world_history WHERE world=$1 AND guest=$2",
    [world, a.guest],
  );
  await history.awaitRows((rows) => rows.length === 0, 20000);

  // Representative history includes expanded models that must stay server side.
  const preview = {
    parts: compileBlueprint(fixture).parts,
    title: fixture.title,
  };
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    jobs.push(id);
    await pool.query(
      "INSERT INTO ai_generations(id,guest,target,prompt,model,status,blueprint,preview) VALUES($1,$2,$3,'Historical fixture','fixture','accepted',$4::jsonb,$5::jsonb)",
      [
        id,
        a.guest,
        world,
        JSON.stringify(fixture),
        JSON.stringify({
          ...preview,
          parts: Array(100).fill(preview.parts[0]),
        }),
      ],
    );
  }
  const id = randomUUID();
  jobs.push(id);
  await createGeneration(
    a,
    { id, prompt: "A synthetic drawing", target: world },
    { dispatch: false },
  );
  console.log("Profile, roles and history passed");
  const query = conversationQuery(a, world!);
  const chat = await rt.subscribe(query);
  await chat.awaitRows(
    (rows) => rows.some((r) => r.id === id && r.status === "queued"),
    20000,
  );
  await pool.query("UPDATE ai_generations SET status='designing' WHERE id=$1", [
    id,
  ]);
  await recordDrawing(id, preview);
  await chat.awaitRows(
    (rows) => rows.some((r) => r.id === id && r.preview?.parts.length === 1),
    20000,
  );
  console.log("Narrowed conversation connected");
  const rows = chat.getSnapshot().data!;
  assert.ok(
    rows
      .filter((r) => r.status === "accepted")
      .every(
        (r) => !r.preview && r.summary === fixture.summary && !r.blueprint,
      ),
  );
  const old = await pool.query(
    "SELECT blueprint,preview,prompt,status FROM ai_generations WHERE target=$1",
    [world],
  );
  const oldBytes = Buffer.byteLength(JSON.stringify(old.rows));
  const newBytes = Buffer.byteLength(JSON.stringify(rows));
  assert.ok(newBytes < oldBytes / 5, `${oldBytes} -> ${newBytes}`);
  const explain = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    query.parameters.map((p) => p.value),
  );
  await mkdir("artifacts/realtime-fixes", { recursive: true });
  await writeFile(
    "artifacts/realtime-fixes/query-plan.json",
    JSON.stringify(explain.rows, null, 2),
  );
  await pool.query(
    "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,lease_until=NULL WHERE id=$1",
    [id, JSON.stringify(fixture)],
  );
  await chat.awaitRows(
    (rows) =>
      rows.some((r) => r.id === id && r.status === "ready" && !!r.preview),
    20000,
  );

  // Inference runs in this process; cancellation is committed by another
  // invocation. There is no shared AbortController and no status SELECT loop.
  const cancelId = randomUUID();
  jobs.push(cancelId);
  await createGeneration(
    a,
    { id: cancelId, prompt: "Synthetic cancellable build", target: world },
    { dispatch: false },
  );
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = runGeneration(a, cancelId, async (_p, _r, signal) => {
    started();
    return await new Promise((_resolve, reject) => {
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  });
  await startedPromise;
  await pool.query("UPDATE ai_generations SET status='cancelled' WHERE id=$1", [
    cancelId,
  ]);
  const result = await Promise.race([
    run,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Realtime cancellation timed out")),
        20000,
      ).unref(),
    ),
  ]);
  assert.equal(result.status, "cancelled");
  const expiredId = randomUUID();
  jobs.push(expiredId);
  await createGeneration(
    a,
    { id: expiredId, prompt: "Interrupted fixture", target: world },
    { dispatch: false },
  );
  await pool.query(
    "UPDATE ai_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expiredId],
  );
  await expireGenerations();
  await chat.awaitRows(
    (rows) => rows.some((r) => r.id === expiredId && r.status === "failed"),
    20000,
  );
  await pool.query(
    "UPDATE world_memberships SET active=0 WHERE world=$1 AND guest=$2",
    [world, a.guest],
  );
  await chat.awaitRows((rows) => rows.length === 0, 20000);
  await member.awaitRows((rows) => rows.length === 0, 20000);
  console.log(
    `Realtime qualification passed: live profile/role, empty history, narrowed chat/drawings, cross-process cancellation, expiry and access withdrawal. History payload ${oldBytes} -> ${newBytes} bytes. No inference calls.`,
  );
} catch (error) {
  console.error("[realtime-qualification]", error);
  throw error;
} finally {
  rt.close();
  if (jobs.length)
    await pool.query("DELETE FROM ai_generations WHERE id=ANY($1::uuid[])", [
      jobs,
    ]);
  if (world) {
    for (const table of [
      "viewer_sessions",
      "guest_world_history",
      "world_memberships",
      "spatial_buckets",
    ])
      await pool.query(`DELETE FROM ${table} WHERE world=$1`, [world]);
    await pool.query("DELETE FROM worlds WHERE id=$1", [world]);
  }
  if (guests.length) {
    await pool.query("DELETE FROM guest_sessions WHERE guest=ANY($1::uuid[])", [
      guests,
    ]);
    await pool.query("DELETE FROM guests WHERE id=ANY($1::uuid[])", [guests]);
  }
  await pool.end();
}
