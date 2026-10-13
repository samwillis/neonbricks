import { createGeneration } from "../src/server/ai";
import { authenticate, DomainError } from "../src/server/auth";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "./node-websocket";
import { createRealtimeClient } from "@neon/realtime/client";
import { pool } from "../src/server/db";
import { recordDrawing } from "../src/server/ai";
import { compileBlueprint } from "../src/shared/blueprint";
import type { AIGeneration, AIConversationRow } from "../src/shared/types";
const base = process.env.VITE_API_URL!.replace(/\/$/, "");
const ids: string[] = [];
let world: string | undefined;
const client = createRealtimeClient({
  url: process.env.VITE_NEON_REALTIME_URL!,
});
async function request(token: string, path: string, body?: unknown) {
  if (path === "/ai/generations" && body && true) {
    try {
      return {
        status: 201,
        data: await createGeneration(
          await authenticate(`Bearer ${token}`),
          body as Parameters<typeof createGeneration>[1],
          { dispatch: false },
        ),
      };
    } catch (error) {
      if (error instanceof DomainError)
        return { status: error.status, data: { error: error.message } };
      throw error;
    }
  }
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
    "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,preview=$3::jsonb,preview_version=preview_version+1,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [
      id,
      JSON.stringify(blueprint),
      JSON.stringify({
        parts: compileBlueprint(blueprint).parts,
        title: "AI chat fixture",
      }),
    ],
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
    name: "AI chat collaborator",
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
  assert.equal((await request(b.token, `/ai/generations/${id}`)).status, 403);
  assert.equal(
    (await request(b.token, `/ai/generations/${id}/live`)).status,
    403,
  );
  assert.equal(
    (await request(b.token, `/worlds/${world}/live/ai`)).status,
    403,
  );
  await ok(a.token, `/worlds/${job.target_slug}/join`, {});
  await ok(b.token, `/worlds/${job.target_slug}/join`, {});
  const viewer = await ok("", "/session", {
    name: "AI chat viewer",
    color: "#486fa4",
  });
  await ok(viewer.token, `/worlds/${job.target_slug}/join`, {});
  await pool.query(
    "UPDATE world_memberships SET role='viewer' WHERE world=$1 AND guest=$2",
    [world, viewer.guest],
  );
  assert.equal(
    (await ok(viewer.token, `/worlds/${job.target_slug}/join`, {})).canBuildAI,
    false,
  );
  assert.equal((await ok(viewer.token, `/worlds/${world}/ai`)).length, 1);
  for (const action of ["run", "cancel", "accept"])
    assert.equal(
      (await request(viewer.token, `/ai/generations/${id}/${action}`, {}))
        .status,
      403,
    );
  assert.equal(
    (
      await request(viewer.token, "/ai/generations", {
        id: randomUUID(),
        prompt: "Viewer cannot build",
        target: world,
      })
    ).status,
    403,
  );
  const peerSub = client.subscribe<AIConversationRow>(
    await ok(b.token, `/worlds/${world}/live/ai`),
  );
  await peerSub.awaitRows(
    (rows) =>
      rows.some(
        (r) => r.id === id && r.author === a.guest && r.author_name === a.name,
      ),
    20000,
  );
  const deniedId = randomUUID();
  assert.equal(
    (
      await request(b.token, "/ai/generations", {
        id: deniedId,
        prompt: "Competing workshop build",
        target: world,
      })
    ).status,
    409,
  );
  assert.equal(
    (await pool.query("SELECT id FROM ai_generations WHERE id=$1", [deniedId]))
      .rowCount,
    0,
  );
  assert.equal((await parts()).length, 0);
  const sub = client.subscribe<AIConversationRow>(
    await ok(a.token, `/worlds/${world}/live/ai`),
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
  await peerSub.awaitRows(
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
    [a, b, a].map((member) =>
      ok(member.token, `/ai/generations/${id}/accept`, {}),
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
  await peerSub.awaitRows(
    (rows) => rows.some((r) => r.id === id && r.status === "accepted"),
    20000,
  );
  const operationOwner = (
    await pool.query(
      "SELECT guest FROM build_operations WHERE world=$1 AND id=$2",
      [world, id],
    )
  ).rows[0].guest;
  const applyingToken = operationOwner === a.guest ? a.token : b.token;
  const undo = await ok(applyingToken, `/worlds/${world}/edit`, {
    operationId: randomUUID(),
    generation: 1,
    action: "undo",
    target: id,
  });
  assert.equal(undo.accepted, true);
  assert.equal((await parts()).length, 0);
  const redo = await ok(applyingToken, `/worlds/${world}/edit`, {
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
  await ok(b.token, "/ai/generations", {
    id: refinementId,
    prompt: "Make the roof blue",
    target: world,
  });
  await sub.awaitRows(
    (rows) => rows.some((r) => r.id === refinementId && r.author === b.guest),
    20000,
  );
  await peerSub.awaitRows(
    (rows) => rows.some((r) => r.id === refinementId && r.author === b.guest),
    20000,
  );
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
  await ok(b.token, "/ai/generations", {
    id: child,
    prompt: "Refine the unapplied draft",
    target: world,
    source: parent,
  });
  await ready(child, parentRef);
  await ok(b.token, `/ai/generations/${child}/cancel`, {});
  const discarded = await pool.query(
    "SELECT status FROM ai_generations WHERE id=ANY($1::uuid[])",
    [[parent, child]],
  );
  assert.ok(
    discarded.rows.every((r) => r.status === "cancelled"),
    "Discarding a draft does not resurrect earlier unapplied drafts after reload",
  );
  const sharedHistory = await ok(b.token, `/worlds/${world}/ai`);
  assert.equal(
    sharedHistory.length,
    5,
    "All members see the workshop conversation",
  );
  assert.equal(
    sharedHistory.find((r: AIConversationRow) => r.id === refinementId).author,
    b.guest,
  );
  await peerSub.awaitRows(
    (rows) =>
      rows.filter(
        (r) => (r.id === parent || r.id === child) && r.status === "cancelled",
      ).length === 2,
    20000,
  );
  const raceIds = [randomUUID(), randomUUID()];
  ids.push(...raceIds);
  const reservations = await Promise.all(
    [a, b].map((member, i) =>
      request(member.token, "/ai/generations", {
        id: raceIds[i],
        prompt: "Concurrent workshop reservation",
        target: world,
      }),
    ),
  );
  assert.deepEqual(reservations.map((r) => r.status).sort(), [201, 409]);
  const winner = reservations.find((r) => r.status === 201)!;
  const otherEditor = winner.data.author === a.guest ? b : a;
  await ok(otherEditor.token, `/ai/generations/${winner.data.id}/cancel`, {});
  await pool.query(
    "UPDATE world_memberships SET active=0 WHERE world=$1 AND guest=$2",
    [world, b.guest],
  );
  await peerSub.awaitRows((rows) => rows.length === 0, 20000);
  for (const path of [
    `/worlds/${world}/ai`,
    `/worlds/${world}/live/ai`,
    `/ai/generations/${refinementId}`,
  ])
    assert.equal((await request(b.token, path)).status, 403);
  for (const action of ["cancel", "accept"])
    assert.equal(
      (await request(b.token, `/ai/generations/${parent}/${action}`, {}))
        .status,
      403,
    );
  // A different session loses its own subscription on revocation; the author's
  // session does not control collaborators' access to workshop chat.
  const viewerSub = client.subscribe<AIConversationRow>(
    await ok(viewer.token, `/worlds/${world}/live/ai`),
  );
  await viewerSub.awaitRows((rows) => rows.length === 6, 20000);
  await pool.query("UPDATE guest_sessions SET revoked=1 WHERE guest=$1", [
    a.guest,
  ]);
  await viewerSub.awaitRows((rows) => rows.length === 6, 20000);
  await pool.query("UPDATE guest_sessions SET revoked=1 WHERE guest=$1", [
    viewer.guest,
  ]);
  await viewerSub.awaitRows((rows) => rows.length === 0, 20000);
  viewerSub.unsubscribe();
  peerSub.unsubscribe();
  sub.unsubscribe();
  console.log(
    "AI chat lifecycle passed: blank workshop, idempotency, shared authored history, peer prompt discovery and drawings, viewer permissions, withdrawal/revocation, workshop concurrency, atomic same-model apply, undo/redo, identity-preserving refinement, concurrent-edit conflict, and late-stream rejection. No inference calls.",
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
