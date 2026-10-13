import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "./node-websocket";
import { createRealtimeClient } from "@neon/realtime/client";
import { pool } from "../src/server/db";
import { recordDrawing } from "../src/server/ai";
import { compileBlueprint } from "../src/shared/blueprint";
import type { AIGeneration, AIGenerationProgress } from "../src/shared/types";
const base = process.env.VITE_API_URL!.replace(/\/$/, "");
const ids: string[] = [];
let world: string | undefined;
const client = createRealtimeClient({
  url: process.env.VITE_NEON_REALTIME_URL!,
});
async function request(token: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, data: await res.json() };
}
async function ok(token: string, path: string, body?: unknown) {
  const result = await request(token, path, body);
  assert.ok(
    result.status < 300,
    `${path}: ${result.status}: ${result.data.error}`,
  );
  return result.data;
}
async function ready(id: string, blueprint: unknown) {
  await pool.query(
    "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [id, JSON.stringify(blueprint)],
  );
}
async function parts() {
  return (
    await pool.query(
      "SELECT id,key,color,revision FROM part_instances WHERE world=$1 AND deleted=0 ORDER BY id",
      [world],
    )
  ).rows;
}
const fixture = {
  version: 1,
  catalogue: "workshop-1",
  title: "AI chat fixture",
  summary: "A small tower.",
  parts: [
    {
      id: "floor",
      part: "plate-4x4",
      colour: "sand",
      at: [-2, 0, -2],
      turn: 0,
      attach: null,
    },
    {
      id: "body",
      part: "brick-2x2",
      colour: "jade",
      at: [-1, 1, -1],
      turn: 0,
      attach: null,
    },
    {
      id: "cap",
      part: "slope-2x2",
      colour: "poppy",
      at: [-1, 4, -1],
      turn: 0,
      attach: null,
    },
  ],
};
try {
  const a = await ok("", "/session", {
    name: "AI chat qualification",
    color: "#289b74",
  });
  const b = await ok("", "/session", {
    name: "AI chat outsider",
    color: "#486fa4",
  });
  const id = randomUUID();
  ids.push(id);
  const input = { id, prompt: "Disposable chat fixture", newWorld: true };
  const job: AIGeneration = await ok(a.token, "/ai/generations", input);
  world = job.target!;
  assert.ok(world);
  assert.ok(job.target_slug);
  assert.equal((await ok(a.token, "/ai/generations", input)).target, world);
  assert.equal((await request(b.token, `/worlds/${world}/ai`)).status, 403);
  assert.equal(
    (
      await request(b.token, "/ai/generations", {
        id: randomUUID(),
        prompt: "Unauthorized target",
        target: world,
      })
    ).status,
    403,
  );
  await ok(a.token, `/worlds/${job.target_slug}/join`, {});
  assert.equal((await parts()).length, 0);
  const sub = client.subscribe<AIGenerationProgress>(
    await ok(a.token, `/ai/generations/${id}/live`),
  );
  await sub.awaitRows((rows) => rows.some((r) => r.status === "queued"), 20000);
  await pool.query("UPDATE ai_generations SET status='designing' WHERE id=$1", [
    id,
  ]);
  const drawing = {
    parts: compileBlueprint(fixture).parts.slice(0, 1),
    title: "AI chat fixture",
  };
  assert.equal(await recordDrawing(id, drawing), true);
  await sub.awaitRows(
    (rows) => rows.some((r) => r.preview?.parts.length === 1),
    20000,
  );
  assert.equal(
    (await parts()).length,
    0,
    "Streaming never mutates the workshop",
  );
  await ready(id, fixture);
  const accepted = await Promise.all(
    Array.from({ length: 3 }, () =>
      ok(a.token, `/ai/generations/${id}/accept`, {}),
    ),
  );
  assert.equal(new Set(accepted.map((r) => r.slug)).size, 1);
  assert.equal(accepted[0].slug, job.target_slug);
  assert.equal((await parts()).length, 3);
  assert.equal(
    await recordDrawing(id, drawing),
    false,
    "Accepted drafts reject late stream writes",
  );
  const undo = await ok(a.token, `/worlds/${world}/edit`, {
    operationId: randomUUID(),
    generation: 1,
    action: "undo",
    target: id,
  });
  assert.equal(undo.accepted, true);
  assert.equal((await parts()).length, 0);
  const redo = await ok(a.token, `/worlds/${world}/edit`, {
    operationId: randomUUID(),
    generation: 1,
    action: "redo",
    target: id,
  });
  assert.equal(redo.accepted, true);
  assert.equal((await parts()).length, 3);
  const original = await parts();
  const refinementId = randomUUID();
  ids.push(refinementId);
  await ok(a.token, "/ai/generations", {
    id: refinementId,
    prompt: "Make the roof blue",
    target: world,
  });
  const reference = (
    await pool.query("SELECT reference FROM ai_generations WHERE id=$1", [
      refinementId,
    ])
  ).rows[0].reference;
  assert.equal(reference.version, 2);
  assert.equal(reference.pieces.length, 3);
  const design = {
    ...reference,
    pieces: reference.pieces.map((p: any) =>
      p.part === "slope-2x2" ? { ...p, colour: "cobalt" } : p,
    ),
  };
  await ready(refinementId, design);
  assert.equal(
    (await ok(a.token, `/ai/generations/${refinementId}/accept`, {})).slug,
    job.target_slug,
  );
  const changed = await parts();
  assert.deepEqual(
    changed.map((p) => p.id),
    original.map((p) => p.id),
  );
  assert.equal(changed.find((p) => p.key === "slope-2x2").color, "#486fa4");
  const staleId = randomUUID();
  ids.push(staleId);
  await ok(a.token, "/ai/generations", {
    id: staleId,
    prompt: "A stale draft",
    target: world,
  });
  const staleReference = (
    await pool.query("SELECT reference FROM ai_generations WHERE id=$1", [
      staleId,
    ])
  ).rows[0].reference;
  await ready(staleId, staleReference);
  const moved = changed[0];
  const edit = await ok(a.token, `/worlds/${world}/edit`, {
    operationId: randomUUID(),
    generation: 1,
    action: "edit",
    changes: [{ id: moved.id, expected: moved.revision, color: "#edbc46" }],
  });
  assert.equal(edit.accepted, true);
  const conflict = await request(
    a.token,
    `/ai/generations/${staleId}/accept`,
    {},
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /changed while AI/);
  assert.equal((await parts()).find((p) => p.id === moved.id).color, "#edbc46");
  await ok(a.token, `/ai/generations/${staleId}/cancel`, {});
  assert.equal(await recordDrawing(staleId, drawing), false);
  const history = await ok(a.token, `/worlds/${world}/ai`);
  assert.equal(history.length, 3);
  assert.equal(history[1].status, "accepted");
  const parent = randomUUID(),
    child = randomUUID();
  ids.push(parent, child);
  await ok(a.token, "/ai/generations", {
    id: parent,
    prompt: "Unapplied parent draft",
    target: world,
  });
  const parentRef = (
    await pool.query("SELECT reference FROM ai_generations WHERE id=$1", [
      parent,
    ])
  ).rows[0].reference;
  await ready(parent, parentRef);
  await ok(a.token, "/ai/generations", {
    id: child,
    prompt: "Refine the unapplied draft",
    target: world,
    source: parent,
  });
  await ready(child, parentRef);
  await ok(a.token, `/ai/generations/${child}/cancel`, {});
  const discarded = await pool.query(
    "SELECT status FROM ai_generations WHERE id=ANY($1::uuid[])",
    [[parent, child]],
  );
  assert.ok(
    discarded.rows.every((r) => r.status === "cancelled"),
    "Discarding a draft does not resurrect earlier unapplied drafts after reload",
  );
  await ok(b.token, `/worlds/${job.target_slug}/join`, {});
  assert.equal(
    (await ok(b.token, `/worlds/${world}/ai`)).length,
    0,
    "Chat remains private to its author",
  );
  console.log(
    "AI chat lifecycle passed: blank workshop, idempotency, private history, Realtime drawings, atomic same-model apply, undo/redo, identity-preserving refinement, concurrent-edit conflict, and late-stream rejection. No inference calls.",
  );
} finally {
  client.close();
  if (world)
    await pool.query("UPDATE worlds SET status='closed' WHERE id=$1", [world]);
  if (ids.length)
    await pool.query("DELETE FROM ai_generations WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
  await pool.end();
}
