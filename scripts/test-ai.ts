import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import "./node-websocket";
import { createRealtimeClient } from "@neon/realtime/client";
import { pool } from "../src/server/db";
import { compileBlueprint } from "../src/shared/blueprint";
import { recordGenerationAttempt } from "../src/server/ai";
import type { AIGenerationProgress, AIGeneration } from "../src/shared/types";
const base = (process.env.TEST_API_URL || process.env.VITE_API_URL!).replace(
  /\/$/,
  "",
);
async function request(token: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(token: string, path: string, body?: unknown) {
  const result = await request(token, path, body);
  assert.ok(
    result.status < 300,
    `${path}: ${result.status}: ${result.data.error}`,
  );
  return result.data;
}
const fixture = {
  version: 1,
  catalogue: "workshop-1",
  title: "AI qualification — disposable",
  summary: "A small stacked fixture.",
  parts: [
    {
      id: "base",
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
      id: "roof",
      part: "slope-2x2",
      colour: "poppy",
      at: [-1, 4, -1],
      turn: 0,
      attach: null,
    },
  ],
};
const client = createRealtimeClient({
  url: process.env.VITE_NEON_REALTIME_URL!,
});
const records: string[] = [];
const worlds: string[] = [];
let fixtureWorld: string | undefined;
try {
  const a = await ok("", "/session", {
    name: "AI qualification",
    color: "#289b74",
  });
  const b = await ok("", "/session", { name: "AI outsider", color: "#edbc46" });
  assert.equal((await request("", "/ai/config")).status, 401);
  assert.equal((await ok(a.token, "/ai/config")).available, true);
  if (!process.argv.includes("--generate-only")) {
    const create = async () => {
      // Retain the source fixture until snapshot/acceptance checks finish, but
      // release completed synthetic probes before reserving the next one.
      if (records.length > 1)
        await pool.query(
          "DELETE FROM ai_generations WHERE id=ANY($1::uuid[]) AND status IN ('ready','accepted','cancelled','failed')",
          [records.slice(1)],
        );
      const id = randomUUID();
      records.push(id);
      return ok(a.token, "/ai/generations", {
        id,
        prompt: "Disposable test build",
      });
    };
    const job = await create();
    const sub = client.subscribe<AIGenerationProgress>(
      await ok(a.token, `/ai/generations/${job.id}/live`),
    );
    await sub.awaitRows(
      (rows) => rows.some((r) => r.status === "queued"),
      20000,
    );
    assert.equal(
      (await request(b.token, `/ai/generations/${job.id}`)).status,
      404,
    );
    assert.equal(
      (await request(b.token, `/ai/generations/${job.id}/live`)).status,
      404,
    );
    assert.equal(
      (await request(b.token, `/ai/generations/${job.id}/accept`, {})).status,
      404,
    );
    assert.equal(
      (
        await request(a.token, "/ai/generations", {
          id: job.id,
          prompt: "Disposable test build",
        })
      ).data.id,
      job.id,
    );
    assert.equal(
      (
        await request(a.token, "/ai/generations", {
          id: randomUUID(),
          prompt: "Another queued build",
        })
      ).status,
      429,
    );
    await pool.query(
      "UPDATE ai_generations SET status='designing' WHERE id=$1",
      [job.id],
    );
    assert.equal(await recordGenerationAttempt(job.id, 1, "checking"), true);
    assert.equal(
      await recordGenerationAttempt(job.id, 1, "checking", {
        blueprint: fixture,
        inputTokens: 11,
        outputTokens: 22,
        elapsedMs: 123,
        issues: [],
      }),
      true,
    );
    const recorded = (
      await pool.query(
        "SELECT input_tokens,output_tokens,attempts FROM ai_generations WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(recorded.input_tokens, 11);
    assert.equal(recorded.output_tokens, 22);
    assert.deepEqual(recorded.attempts["1"].blueprint, fixture);
    const rejected = { ...fixture, title: "Rejected collision fixture" };
    assert.equal(
      await recordGenerationAttempt(job.id, 2, "checking", {
        blueprint: rejected,
        inputTokens: 13,
        outputTokens: 17,
        issues: [
          { code: "overlap", parts: ["base", "body"], message: "Collision" },
        ],
        issueCounts: { overlap: 1 },
        bestBlueprint: fixture,
        bestIssues: [],
        bestIssueCounts: {},
        retainedPrevious: true,
      }),
      true,
    );
    const retained = (
      await pool.query(
        "SELECT blueprint,issues,input_tokens,output_tokens,attempts,activity FROM ai_generations WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.deepEqual(retained.blueprint, fixture);
    assert.deepEqual(retained.issues, []);
    assert.deepEqual(retained.attempts["2"].blueprint, rejected);
    assert.equal(retained.attempts["2"].retainedPrevious, true);
    assert.equal(retained.input_tokens, 24);
    assert.equal(retained.output_tokens, 39);
    assert.match(retained.activity, /Keeping the better draft/);
    await sub.awaitRows(
      (rows) => rows.some((r) => r.status === "checking"),
      20000,
    );
    await pool.query(
      "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb,lease_until=NULL WHERE id=$1",
      [job.id, JSON.stringify(fixture)],
    );
    await sub.awaitRows(
      (rows) => rows.some((r) => r.status === "ready"),
      20000,
    );
    const accepted = await Promise.all(
      Array.from({ length: 3 }, () =>
        ok(a.token, `/ai/generations/${job.id}/accept`, {}),
      ),
    );
    assert.equal(new Set(accepted.map((w) => w.slug)).size, 1);
    // Completed requests never block a new build, even beyond the old global
    // daily and per-guest hourly quotas. These synthetic rows make no inference.
    const completedIds = Array.from({ length: 41 }, () => randomUUID());
    records.push(...completedIds);
    await pool.query(
      "INSERT INTO ai_generations(id,guest,prompt,model,status) SELECT id,$2,'Completed quota regression fixture','test','cancelled' FROM unnest($1::uuid[]) AS id",
      [completedIds, a.guest],
    );
    const revisionId = randomUUID();
    records.push(revisionId);
    const revision = {
      id: revisionId,
      prompt: "Make the roof blue",
      source: job.id,
    };
    await ok(a.token, "/ai/generations", revision);
    const snapshot = (
      await pool.query(
        "SELECT source,reference FROM ai_generations WHERE id=$1",
        [revisionId],
      )
    ).rows[0];
    assert.equal(snapshot.source, job.id);
    assert.deepEqual(snapshot.reference, fixture);
    assert.equal(
      (await ok(a.token, "/ai/generations", revision)).id,
      revisionId,
    );
    assert.equal(
      (
        await request(a.token, "/ai/generations", {
          ...revision,
          source: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(b.token, "/ai/generations", {
          id: randomUUID(),
          prompt: "Copy the private draft",
          source: job.id,
        })
      ).status,
      404,
    );
    await ok(a.token, `/ai/generations/${revisionId}/cancel`, {});
    const joined = await ok(a.token, `/worlds/${accepted[0].slug}/join`, {});
    worlds.push(joined.world.id);
    fixtureWorld = joined.world.id;
    const imported = await pool.query(
      "SELECT count(*)::int AS n FROM part_instances WHERE world=$1 AND deleted=0",
      [joined.world.id],
    );
    assert.equal(imported.rows[0].n, 3);
    const topology = await pool.query(
      "SELECT count(*)::int AS n FROM part_connections WHERE world=$1 AND deleted=0",
      [joined.world.id],
    );
    assert.equal(topology.rows[0].n, compileBlueprint(fixture).edges.length);
    const p = (
      await pool.query(
        "SELECT * FROM part_instances WHERE world=$1 ORDER BY y LIMIT 1",
        [joined.world.id],
      )
    ).rows[0];
    const recolour = await ok(a.token, `/worlds/${joined.world.id}/edit`, {
      operationId: randomUUID(),
      generation: 1,
      action: "edit",
      changes: [{ id: p.id, expected: 1, color: "#72a6c8" }],
    });
    assert.equal(recolour.accepted, true);
    const collision = await ok(a.token, `/worlds/${joined.world.id}/edit`, {
      operationId: randomUUID(),
      generation: 1,
      action: "edit",
      changes: [
        {
          id: randomUUID(),
          key: "brick-1x1",
          color: "#289b74",
          position: { x: -12, y: 0, z: -12 },
          rotation: 0,
        },
      ],
    });
    assert.equal(collision.accepted, false);
    assert.equal(collision.error, "That space is occupied");
    const cancelled = await create();
    assert.equal(
      (await ok(a.token, `/ai/generations/${cancelled.id}/cancel`, {})).status,
      "cancelled",
    );
    assert.equal(
      (await ok(a.token, `/ai/generations/${cancelled.id}/run`, {})).status,
      "cancelled",
    );
    assert.equal(
      await recordGenerationAttempt(cancelled.id, 1, "checking", {
        blueprint: fixture,
        inputTokens: 99,
        outputTokens: 99,
      }),
      false,
    );
    const invalid = await create();
    await pool.query(
      "UPDATE ai_generations SET status='ready',blueprint=$2::jsonb WHERE id=$1",
      [
        invalid.id,
        JSON.stringify({
          ...fixture,
          parts: [fixture.parts[0], { ...fixture.parts[1], at: [-2, 0, -2] }],
        }),
      ],
    );
    assert.equal(
      (await request(a.token, `/ai/generations/${invalid.id}/accept`, {}))
        .status,
      409,
    );
    assert.equal(
      (
        await pool.query("SELECT world FROM ai_generations WHERE id=$1", [
          invalid.id,
        ])
      ).rows[0].world,
      null,
    );
    const expired = await create();
    await pool.query(
      "UPDATE ai_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    assert.equal(
      (await ok(a.token, `/ai/generations/${expired.id}`)).status,
      "failed",
    );
    console.log(
      "AI lifecycle passed: authenticated access, Realtime stages, concurrency admission, no completed-request quotas, concurrent acceptance, topology, normal edits, cancellation, validation rollback, interruption recovery.",
    );
  }
  if (
    process.argv.includes("--generate") ||
    process.argv.includes("--generate-only")
  ) {
    const id = randomUUID();
    const prompt =
      process.env.AI_TEST_PROMPT ||
      "A cosy little cabin with a red roof, an open doorway, a chimney and a pine tree beside it. Use around 40–60 pieces.";
    await ok(a.token, "/ai/generations", { id, prompt });
    const progress = client.subscribe<AIGenerationProgress>(
      await ok(a.token, `/ai/generations/${id}/live`),
    );
    const stages: string[] = [];
    progress.onChange((s) => {
      const stage = s.data?.[0]?.status;
      if (stage && stages.at(-1) !== stage) {
        stages.push(stage);
        console.log("Generation stage:", stage);
      }
    });
    await progress.awaitRows(
      (rows) => rows.some((r) => r.status === "queued"),
      20000,
    );
    const started = performance.now();
    const built: AIGeneration = await ok(
      a.token,
      `/ai/generations/${id}/run`,
      {},
    );
    const elapsed = Math.round(performance.now() - started);
    const stats = (
      await pool.query(
        "SELECT model,attempt,input_tokens,output_tokens,issues,error FROM ai_generations WHERE id=$1",
        [id],
      )
    ).rows[0];
    console.log(
      JSON.stringify({
        elapsedMs: elapsed,
        status: built.status,
        parts: built.parts.length,
        stages,
        ...stats,
      }),
    );
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/ai-generation.json",
      JSON.stringify(
        { id, prompt, elapsedMs: elapsed, stages, stats, generation: built },
        null,
        2,
      ),
    );
    assert.equal(built.status, "ready", built.error || "Generation failed");
    const result = await ok(a.token, `/ai/generations/${id}/accept`, {});
    const w = await ok(a.token, `/worlds/${result.slug}/join`, {});
    worlds.push(w.world.id);
    console.log("Generated workshop:", result.slug);
  }
} finally {
  client.close();
  // Keep generated models for visual inspection. Close only fixture worlds.
  if (fixtureWorld)
    await pool.query("UPDATE worlds SET status='closed' WHERE id=$1", [
      fixtureWorld,
    ]);
  // Remove only the synthetic jobs created by the no-inference fixture suite.
  // Paid generations and their previews stay available for review/refinement.
  if (records.length)
    await pool.query("DELETE FROM ai_generations WHERE id=ANY($1::uuid[])", [
      records,
    ]);
  await pool.end();
}
