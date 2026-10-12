import assert from "node:assert/strict";
import "./node-websocket";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createRealtimeClient,
  type SealedLiveQuery,
  type MaterializedLiveQuerySubscription,
} from "@neon/realtime/client";
import { pool } from "../src/server/db";
import { bounds, validPart } from "../src/shared/geometry";
import type { Part, SceneRow, Receipt } from "../src/shared/types";
const base = (process.env.TEST_API_URL || process.env.VITE_API_URL!).replace(
  /\/$/,
  "",
);
const burst = Number(process.env.BURST_SECONDS || 60),
  steady = Number(process.env.STEADY_SECONDS || 600),
  size = Number(process.env.SCENE_PARTS || 2000),
  builders = Number(process.env.BENCH_BUILDERS || 12);
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
  const result = await r.json();
  const timing = r.headers.get("server-timing")?.match(/app;dur=([\d.]+)/);
  if (path.endsWith("/edit") && timing) serverTimes.push(Number(timing[1]));
  assert.ok(r.ok, `${r.status}: ${result.error}`);
  return result;
}
const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clients: ReturnType<typeof createRealtimeClient>[] = [],
  timers: ReturnType<typeof setInterval>[] = [];
type Builder = {
  token: string;
  viewer: string;
  sub: MaterializedLiveQuerySubscription<SceneRow>;
  p: Part;
  sequence: number;
};
const participants: Builder[] = [],
  latencies: number[] = [],
  requestTimes: number[] = [],
  serverTimes: number[] = [],
  errors: string[] = [];
const diagnostics: Record<string, number> = {},
  states: Record<string, number> = {};
const watches = new Set<{
  id: string;
  revision: number;
  deleted: boolean;
  sent: number;
  measure: boolean;
  resolve: () => void;
}>();
let commands = 0,
  world: any,
  peerRows = new Map<string, SceneRow>();
try {
  const owner = await api<{ token: string }>("", "/session", {
    name: "Capacity owner",
    color: "#289b74",
  });
  world = await api<any>(owner.token, "/worlds", {
    title: `Capacity ${size} — disposable`,
    starter: "empty",
  });
  const keys = [
    "brick-1x1",
    "brick-1x2",
    "plate-1x1",
    "plate-1x2",
    "tile-1x1",
    "round",
    "bearing",
  ];
  const parts: Part[] = Array.from({ length: size }, (_, i) => ({
    id: randomUUID(),
    key: keys[i % keys.length],
    color: ["#289b74", "#edbc46", "#d9594e", "#72a6c8"][i % 4],
    position: {
      x: -96 + (i % 16) * 12,
      y: Math.floor(i / 256) * 8,
      z: -96 + (Math.floor(i / 16) % 16) * 12,
    },
    rotation: 0,
    revision: 1,
  }));
  assert.ok(parts.every(validPart), "Fixture exceeds the board");
  const bs = parts.map(bounds);
  await pool.query(
    "INSERT INTO part_instances(id,world,key,color,x,y,z,rotation,revision,deleted,minx,miny,minz,maxx,maxy,maxz) SELECT id,$1,key,color,x,y,z,0,1,0,minx,miny,minz,maxx,maxy,maxz FROM unnest($2::uuid[],$3::text[],$4::text[],$5::int[],$6::int[],$7::int[],$8::int[],$9::int[],$10::int[],$11::int[],$12::int[],$13::int[]) AS p(id,key,color,x,y,z,minx,miny,minz,maxx,maxy,maxz)",
    [
      world.id,
      parts.map((p) => p.id),
      parts.map((p) => p.key),
      parts.map((p) => p.color),
      parts.map((p) => p.position.x),
      parts.map((p) => p.position.y),
      parts.map((p) => p.position.z),
      bs.map((b) => b.minx),
      bs.map((b) => b.miny),
      bs.map((b) => b.minz),
      bs.map((b) => b.maxx),
      bs.map((b) => b.maxy),
      bs.map((b) => b.maxz),
    ],
  );
  const editable = parts.filter((p) => p.key === "brick-1x1");
  for (let i = 0; i < builders; i++) {
    const session = await api<{ token: string }>("", "/session", {
        name: `Capacity builder ${i + 1}`,
        color: "#289b74",
      }),
      joined = await api<any>(session.token, `/worlds/${world.slug}/join`, {}),
      token = session.token;
    const seal = () =>
        api<SealedLiveQuery<SceneRow>>(token, `/worlds/${world.id}/live/scene`),
      q = await seal(),
      client = createRealtimeClient({
        url: process.env.VITE_NEON_REALTIME_URL!,
        logLevel: "warn",
        logger: (e) => {
          const key = `${e.event}:${(e as any).error?.code || ""}`;
          diagnostics[key] = (diagnostics[key] || 0) + 1;
        },
      }),
      sub = client.subscribe(q);
    clients.push(client);
    await sub.awaitRows(
      (rows) => rows.filter((r) => r.kind === "part").length === size,
      20000,
    );
    timers.push(
      setInterval(() => {
        void seal()
          .then((q) => sub.renew(q))
          .catch((e) => errors.push(`renewal: ${e.message}`));
      }, 35_000),
    );
    for (const kind of ["presence", "history"]) {
      const seal = () =>
          api<SealedLiveQuery<unknown>>(
            token,
            `/worlds/${world.id}/live/${kind}`,
          ),
        aux = client.subscribe(await seal());
      timers.push(
        setInterval(() => {
          void seal()
            .then((q) => aux.renew(q))
            .catch((e) => errors.push(`renewal: ${e.message}`));
        }, 35_000),
      );
    }
    const participant = {
      token,
      viewer: joined.viewer,
      sub,
      p: editable[i],
      sequence: 0,
    };
    participants.push(participant);
    timers.push(
      setInterval(() => {
        void api(token, `/worlds/${world.id}/presence`, {
          viewer: participant.viewer,
          sequence: ++participant.sequence,
          generation: 1,
          selection: [participant.p.id],
          preview: null,
          sample: false,
        }).catch((e) => errors.push(`presence: ${e.message}`));
      }, 10_000),
    );
    if (i === 0)
      sub.onChange((s) => {
        states[s.status] = (states[s.status] || 0) + 1;
        if (s.status === "live") {
          peerRows = new Map(
            s.data?.filter((r) => r.kind === "part").map((r) => [r.id, r]),
          );
          for (const w of watches) {
            const p = peerRows.get(w.id);
            if (w.deleted ? !p : p && p.revision >= w.revision) {
              if (w.measure) latencies.push(performance.now() - w.sent);
              w.resolve();
              watches.delete(w);
            }
          }
        }
      });
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/capacity-room.json",
    JSON.stringify(
      { url: `http://127.0.0.1:5173/w/${world.slug}`, parts: size, builders },
      null,
      2,
    ),
  );
  console.log(
    `Ready: ${size} parts, ${builders} live clients; room /w/${world.slug}`,
  );
  async function runPhase(seconds: number, interval: number, label: string) {
    const begin = performance.now();
    await Promise.all(
      participants.map(async (b, index) => {
        let n = 0;
        while (
          n < Math.ceil((seconds * 1000) / interval) &&
          performance.now() - begin < seconds * 1000
        ) {
          await sleep(begin + n * interval + index * 7 - performance.now());
          if (performance.now() - begin >= seconds * 1000) break;
          const old = b.p,
            deleted = n % 8 === 6,
            replace = !!old.deleted;
          const change = replace
            ? {
                ...old,
                id: randomUUID(),
                deleted: false,
                expected: undefined,
                revision: undefined,
              }
            : {
                id: old.id,
                expected: old.revision,
                ...(deleted
                  ? { deleted: true }
                  : n % 3 === 0
                    ? {
                        position: {
                          ...old.position,
                          x: editable[index].position.x + (n % 2 ? 1 : 0),
                        },
                      }
                    : { color: n % 2 ? "#d9594e" : "#289b74" }),
              };
          const id = change.id,
            revision = replace ? 1 : old.revision + 1,
            sent = performance.now();
          let complete!: () => void;
          const delivered = new Promise<void>((r) => (complete = r)),
            w = {
              id,
              revision,
              deleted,
              sent,
              measure: index !== 0,
              resolve: complete,
            };
          watches.add(w);
          try {
            const receipt = await api<Receipt>(
              b.token,
              `/worlds/${world.id}/edit`,
              {
                operationId: randomUUID(),
                generation: 1,
                action: "edit",
                changes: [change],
                connections: [],
              },
            );
            requestTimes.push(performance.now() - sent);
            assert.ok(receipt.accepted, receipt.error);
            b.p = receipt.parts![0];
            commands++;
            await Promise.race([
              delivered,
              sleep(15000).then(() => {
                if (watches.has(w)) throw new Error("Peer visibility timeout");
              }),
            ]);
          } catch (e) {
            watches.delete(w);
            errors.push((e as Error).message);
          }
          n++;
        }
      }),
    );
    console.log(
      `${label}: ${commands} cumulative commands; ${errors.length} errors`,
    );
  }
  await runPhase(burst, 500, "60-second burst");
  await runPhase(steady, 5000, "steady session");
  const percentile = (xs: number[], n: number) =>
    [...xs].sort((a, b) => a - b)[
      Math.min(xs.length - 1, Math.floor(xs.length * n))
    ];
  const expectedCommands = builders * (burst * 2 + Math.ceil(steady / 5));
  if (commands < expectedCommands)
    errors.push(`Workload shortfall: ${commands}/${expectedCommands}`);
  const report = {
    date: new Date().toISOString(),
    api: base,
    region: "aws-us-east-2",
    client: `Node 22/ws, London; ${builders} independent guest sessions and live clients`,
    parts: size,
    builders,
    burstSeconds: burst,
    steadySeconds: steady,
    commands,
    expectedCommands,
    diagnostics,
    states,
    errors,
    peerVisibilityMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    httpReceiptMs: { p95: percentile(requestTimes, 0.95) },
    functionProcessingMs: {
      p50: percentile(serverTimes, 0.5),
      p95: percentile(serverTimes, 0.95),
    },
    measurement:
      "Command dispatch to authoritative SDK snapshot in one peer; browser frame/render timing is measured separately",
    room: world.slug,
  };
  await writeFile("artifacts/capacity.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0);
} finally {
  timers.forEach(clearInterval);
  clients.forEach((c) => c.close());
  await pool.end();
}
