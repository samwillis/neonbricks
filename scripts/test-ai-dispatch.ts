import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import "./node-websocket";
import { createRealtimeClient } from "@neon/realtime/client";
import type { AIConversationRow } from "../src/shared/types";
if (!process.argv.includes("--generate"))
  throw new Error("Pass --generate to authorize one real Gateway build.");
const base = process.env.VITE_API_URL!.replace(/\/$/, "");
let token = "";
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${data.error}`);
  return data;
}
const rt = createRealtimeClient({ url: process.env.VITE_NEON_REALTIME_URL! });
try {
  const health = await request(`/health?qualification=${Date.now()}`);
  assert.equal(
    health.aiBuilder,
    "realtime-lifecycle-2",
    "Wait for the corrected Function release",
  );
  token = (
    await request("/session", { name: "Server dispatch QA", color: "#289b74" })
  ).token;
  const job = await request("/ai/generations", {
    id: randomUUID(),
    prompt:
      "A tiny green brick tower with a red cap, about five pieces. Keep it simple.",
    newWorld: true,
  });
  const sub = rt.subscribe<AIConversationRow>(
    await request(`/worlds/${job.target}/live/ai`),
  );
  let last = "";
  sub.onChange((snapshot) => {
    const current = snapshot.data?.find((row) => row.id === job.id);
    if (current && current.status !== last) {
      last = current.status;
      console.log(`Server-owned build: ${last}`);
    }
  });
  // No browser panel and no /run request: the Function owns execution.
  await sub.awaitRows(
    (rows) =>
      rows.some(
        (r) =>
          r.id === job.id &&
          ["ready", "failed", "cancelled"].includes(r.status),
      ),
    175000,
  );
  const result = sub.getSnapshot().data!.find((row) => row.id === job.id)!;
  assert.equal(result.status, "ready", result.error || "Build did not finish");
  assert.ok(result.preview?.parts.length);
  await mkdir("artifacts/realtime-fixes", { recursive: true });
  await writeFile(
    "artifacts/realtime-fixes/dispatch.json",
    JSON.stringify(
      {
        slug: job.target_slug,
        world: job.target,
        id: job.id,
        pieces: result.piece_count,
        status: result.status,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS deployed waitUntil dispatch and trusted cancellation subscription. ${result.piece_count} pieces, QA workshop ${job.target_slug}. No client run or lifecycle polling.`,
  );
} finally {
  rt.close();
  if (token) await request("/session/revoke", {}).catch(() => {});
}
