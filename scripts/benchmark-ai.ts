import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pool } from "../src/server/db";
import { AI_BUILDER_VERSION } from "../src/server/ai";

// Fixed, inspectable cases. Every request uses Neon's Gateway spending policy,
// authentication, validation and acceptance path. Never retry a failed case here.
const cases = [
  {
    id: "lookout",
    prompt: "A little forest lookout with a red roof",
  },
  {
    id: "cabin",
    prompt:
      "A cosy woodland cabin with a red pitched roof, an open doorway, a chimney and a pine tree beside it.",
  },
  {
    id: "rover",
    prompt:
      "A yellow exploration rover with four chunky wheels, real axles, a cockpit, headlights and an antenna. A static model.",
  },
  {
    id: "castle",
    prompt:
      "A small medieval castle gatehouse with two towers, crenellations, an arched gateway and a bridge over blue water.",
  },
  {
    id: "dinosaur",
    prompt:
      "A friendly green long-neck dinosaur with four legs, a long tail, a cream belly and a small head with eyes.",
  },
  {
    id: "treehouse",
    prompt:
      "A little treehouse in a broad green tree, with a wooden balcony, a red roof and steps leading up to it.",
  },
  {
    id: "windmill",
    prompt:
      "A little Dutch windmill with a cream tower, a red roof, four blades forming a cross and a garden. A static brick model.",
  },
];
const chosen = (
  process.env.AI_BENCH_CASES || cases.map((c) => c.id).join(",")
).split(",");
if (!chosen.every((id) => cases.some((c) => c.id === id)))
  throw new Error("Unknown benchmark case");
const selected = cases.filter((c) => chosen.includes(c.id));
const label = process.env.AI_BENCH_LABEL || "current";
if (!/^[a-zA-Z0-9_-]{1,50}$/.test(label)) throw new Error("Invalid label");
const base = (process.env.TEST_API_URL || process.env.VITE_API_URL!).replace(
  /\/$/,
  "",
);
async function api(token: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}
await mkdir(`artifacts/ai-benchmark-${label}`, { recursive: true });
const health = await api("", `/health?rollout=${Date.now()}`);
if (health.aiBuilder !== AI_BUILDER_VERSION) {
  await pool.end();
  throw new Error(
    "The deployed AI builder is not this version yet. Wait for rollout before benchmarking.",
  );
}
const results: Record<string, unknown>[] = [];
async function run(test: (typeof cases)[number]) {
  const id = randomUUID();
  const session = await api("", "/session", {
    name: "AI benchmark",
    color: "#289b74",
  });
  const config = await api(session.token, `/ai/config?rollout=${Date.now()}`);
  const expectedModel = process.env.AI_BENCH_MODEL || "gpt-5-4";
  if (config.model !== expectedModel || config.version !== AI_BUILDER_VERSION) {
    throw new Error(
      `Expected ${expectedModel} on ${AI_BUILDER_VERSION}; rollout still serves ${config.model || "unknown"}. No build reserved.`,
    );
  }
  const started = performance.now();
  let result: Record<string, unknown>;
  try {
    await api(session.token, "/ai/generations", { id, prompt: test.prompt });
    const built = await api(session.token, `/ai/generations/${id}/run`, {});
    const elapsedMs = Math.round(performance.now() - started);
    const stats = (
      await pool.query(
        "SELECT model,attempt,input_tokens,output_tokens,issues,error,blueprint,design,attempts FROM ai_generations WHERE id=$1",
        [id],
      )
    ).rows[0];
    let slug: string | null = null;
    if (built.status === "ready")
      slug = (await api(session.token, `/ai/generations/${id}/accept`, {}))
        .slug;
    result = {
      case: test.id,
      prompt: test.prompt,
      id,
      status: built.status,
      elapsedMs,
      parts: built.parts.length,
      slug,
      ...stats,
    };
  } catch (error) {
    result = {
      case: test.id,
      prompt: test.prompt,
      id,
      status: "request_failed",
      elapsedMs: Math.round(performance.now() - started),
      error: (error as Error).message,
    };
  }
  results.push(result);
  await writeFile(
    `artifacts/ai-benchmark-${label}/${test.id}.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      ...result,
      blueprint: undefined,
      design: undefined,
      attempts: undefined,
    }),
  );
}
try {
  // At most two paid builds at once, matching the application's global cap.
  const pending = [...selected];
  await Promise.all(
    Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (pending.length) await run(pending.shift()!);
    }),
  );
  const summary = {
    label,
    successes: results.filter((r) => r.status === "ready").length,
    total: results.length,
    results: results.map(({ blueprint, design, attempts, ...r }) => r),
  };
  await writeFile(
    `artifacts/ai-benchmark-${label}/summary.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      label,
      successes: summary.successes,
      total: summary.total,
    }),
  );
} finally {
  await pool.end();
}
