import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@neon/functions";
import { parseTriggerDelivery } from "@neon/functions/triggers";
import { pool, transaction } from "./db";
import {
  authenticate,
  DomainError,
  lockAccess,
  newSession,
  type Identity,
} from "./auth";
import { createWorld, joinWorld, insertPart } from "./worlds";
import { execute, reconnectParts } from "./commands";
import {
  realtime,
  sceneQuery,
  presenceQuery,
  historyQuery,
  memberQuery,
} from "./live";
import { starter } from "../shared/starter";
import { validPart, collision } from "../shared/geometry";
import { WORLD_LIMIT, HEIGHT_LIMIT, UNIT } from "../shared/types";
import {
  aiAvailable,
  aiConfiguration,
  AI_BUILDER_VERSION,
  createGeneration,
  getGeneration,
  listGenerations,
  conversationQuery,
  runGeneration,
  cancelGeneration,
  acceptGeneration,
  generationQuery,
  expireGenerations,
  dispatchGeneration,
  reconcileGenerations,
} from "./ai";
const origins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
).split(",");
const app = new Hono<{ Variables: { identity: Identity } }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const started = performance.now();
  await next();
  c.header(
    "Server-Timing",
    `app;dur=${(performance.now() - started).toFixed(2)}`,
  );
});
app.use(
  "*",
  cors({
    origin: (o) => (origins.includes(o) ? o : undefined),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 3600,
  }),
);
app.use("*", bodyLimit({ maxSize: 128 * 1024 }));
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    backend: "Neon Functions",
    realtime: !!process.env.REALTIME_SECRET,
    ai: aiAvailable(),
    aiBuilder: AI_BUILDER_VERSION,
  }),
);
const position = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
const preview = z.object({
  key: z.string().max(64),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  position,
  rotation: z.number().int().min(0).max(3),
});
const edit = z.object({
  operationId: z.uuid(),
  generation: z.number().int().positive(),
  action: z.enum(["edit", "undo", "redo"]),
  target: z.uuid().optional(),
  changes: z
    .array(
      z.object({
        id: z.uuid(),
        expected: z.number().int().positive().optional(),
        key: z.string().max(64).optional(),
        color: z
          .string()
          .regex(/^#[\da-f]{6}$/i)
          .optional(),
        position: position.optional(),
        rotation: z.number().int().min(0).max(3).optional(),
        deleted: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  connections: z
    .array(z.object({ id: z.uuid(), revision: z.number().int().positive() }))
    .max(5000)
    .optional(),
});
app.post("/api/session", async (c) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(24),
      color: z.string().regex(/^#[\da-f]{6}$/i),
    })
    .parse(await c.req.json());
  return c.json(await newSession(input.name, input.color), 201);
});
app.post("/api/cleanup", async (c) => {
  const delivery = await parseTriggerDelivery(c.req.raw);
  if (!delivery.ok) return c.json({ error: "Trigger delivery required" }, 401);
  await expireGenerations();
  const result = await transaction(async (client) => {
    const closed = await client.query(
      "UPDATE worlds SET status='closed',generation=generation+1 WHERE status='open' AND expires_at<clock_timestamp() RETURNING id",
    );
    const expired = await client.query(
      "UPDATE guest_sessions SET revoked=1 WHERE revoked=0 AND (expires_at<clock_timestamp() OR absolute_expiry<clock_timestamp()) RETURNING id",
    );
    const r = await client.query(
      "DELETE FROM viewer_sessions WHERE expires_at<clock_timestamp()-interval '5 minutes'",
    );
    return {
      removed: r.rowCount,
      closed: closed.rowCount,
      revoked: expired.rowCount,
    };
  });
  return c.json(result);
});
app.post("/api/ai/reconcile", async (c) => {
  const delivery = await parseTriggerDelivery(c.req.raw);
  if (!delivery.ok || delivery.invocation.type !== "schedule")
    return c.json({ error: "Scheduled trigger delivery required" }, 401);
  await reconcileGenerations();
  return c.json({ ok: true });
});
app.use("/api/*", async (c, next) => {
  c.set("identity", await authenticate(c.req.header("authorization")));
  await next();
});
app.post("/api/session/renew", async (c) => {
  const a = c.get("identity");
  const { rows } = await pool.query(
    "UPDATE guest_sessions SET expires_at=LEAST(absolute_expiry,clock_timestamp()+interval '30 minutes') WHERE id=$1 AND guest=$2 AND revoked=0 AND expires_at>clock_timestamp() AND absolute_expiry>clock_timestamp() RETURNING expires_at",
    [a.session, a.guest],
  );
  if (!rows[0]) throw new DomainError("Session expired", 401);
  return c.json({ expiresAt: rows[0].expires_at, serverTime: Date.now() });
});
app.post("/api/profile", async (c) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(24),
      color: z.string().regex(/^#[\da-f]{6}$/i),
    })
    .parse(await c.req.json());
  await pool.query("UPDATE guests SET name=$2,color=$3 WHERE id=$1", [
    c.get("identity").guest,
    input.name,
    input.color,
  ]);
  return c.json({ ok: true });
});
app.post("/api/session/revoke", async (c) => {
  const a = c.get("identity");
  await pool.query(
    "UPDATE guest_sessions SET revoked=1 WHERE id=$1 AND guest=$2",
    [a.session, a.guest],
  );
  return c.json({ ok: true });
});
app.post("/api/worlds", async (c) => {
  const input = z
    .object({
      title: z.string().trim().min(1).max(64),
      starter: z.enum(["rover", "empty"]),
    })
    .parse(await c.req.json());
  return c.json(
    await createWorld(
      input.title,
      c.get("identity").guest,
      input.starter === "rover",
    ),
    201,
  );
});
app.get("/api/ai/config", (c) => c.json(aiConfiguration()));
app.post("/api/ai/generations", async (c) => {
  const input = z
    .object({
      id: z.uuid(),
      prompt: z.string().trim().min(3).max(1200),
      source: z.uuid().optional(),
      target: z.uuid().optional(),
      newWorld: z.boolean().optional(),
    })
    .refine(
      (v) => !v.newWorld || (!v.target && !v.source),
      "Choose a new or existing workshop",
    )
    .parse(await c.req.json());
  const generation = await createGeneration(c.get("identity"), input);
  if (generation.status === "queued")
    waitUntil(
      dispatchGeneration(generation.id).catch((error) =>
        console.error(
          "[ai-dispatch]",
          generation.id,
          error instanceof Error ? error.name : "Error",
        ),
      ),
    );
  return c.json(generation, 201);
});
app.get("/api/ai/generations/:id", async (c) =>
  c.json(
    await getGeneration(c.get("identity"), z.uuid().parse(c.req.param("id"))),
  ),
);
app.get("/api/worlds/:world/ai", async (c) =>
  c.json(
    await listGenerations(
      c.get("identity"),
      z.uuid().parse(c.req.param("world")),
    ),
  ),
);
app.get("/api/ai/generations/:id/live", async (c) => {
  const a = c.get("identity"),
    id = z.uuid().parse(c.req.param("id"));
  await getGeneration(a, id);
  return c.json(await realtime().seal({ query: generationQuery(a, id) }));
});
app.post("/api/ai/generations/:id/run", async (c) =>
  c.json(
    await runGeneration(c.get("identity"), z.uuid().parse(c.req.param("id"))),
  ),
);
app.post("/api/ai/generations/:id/cancel", async (c) =>
  c.json(
    await cancelGeneration(
      c.get("identity"),
      z.uuid().parse(c.req.param("id")),
    ),
  ),
);
app.post("/api/ai/generations/:id/accept", async (c) =>
  c.json(
    await acceptGeneration(
      c.get("identity"),
      z.uuid().parse(c.req.param("id")),
    ),
  ),
);
app.post("/api/worlds/:slug/join", async (c) =>
  c.json(await joinWorld(c.get("identity"), c.req.param("slug"))),
);
app.get("/api/worlds/:world/live/:kind", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world"));
  await transaction(async (client) => lockAccess(client, a, world, false));
  const kind = c.req.param("kind");
  if (kind === "scene")
    return c.json(await realtime().seal({ query: sceneQuery(world, a) }));
  if (kind === "presence")
    return c.json(await realtime().seal({ query: presenceQuery(world, a) }));
  if (kind === "member")
    return c.json(await realtime().seal({ query: memberQuery(world, a) }));
  if (kind === "history")
    return c.json(await realtime().seal({ query: historyQuery(world, a) }));
  if (kind === "ai")
    return c.json(
      await realtime().seal({ query: conversationQuery(a, world) }),
    );
  throw new DomainError("Unknown query", 404);
});
app.post("/api/worlds/:world/edit", async (c) =>
  c.json(
    await execute(
      c.get("identity"),
      z.uuid().parse(c.req.param("world")),
      edit.parse(await c.req.json()),
    ),
  ),
);
app.get("/api/worlds/:world/history", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world"));
  await transaction((client) => lockAccess(client, a, world, false));
  const { rows } = await pool.query(
    "SELECT h.undo,h.redo,h.generation=w.generation AS current FROM guest_world_history h JOIN worlds w ON w.id=h.world WHERE h.world=$1 AND h.guest=$2",
    [world, a.guest],
  );
  const h = rows[0];
  return c.json({
    undo: h?.current ? h.undo.at(-1)?.id || null : null,
    redo: h?.current ? h.redo.at(-1)?.id || null : null,
  });
});
app.get("/api/worlds/:world/operations/:operation", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world"));
  await transaction((client) => lockAccess(client, a, world, false));
  const { rows } = await pool.query(
    "SELECT receipt FROM build_operations WHERE world=$1 AND guest=$2 AND id=$3",
    [world, a.guest, z.uuid().parse(c.req.param("operation"))],
  );
  if (!rows[0]) throw new DomainError("Operation not found", 404);
  return c.json(rows[0].receipt);
});
app.post("/api/worlds/:world/presence", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world"));
  const v = z
    .object({
      viewer: z.uuid(),
      sequence: z.number().int().min(1).max(2147483647),
      generation: z.number().int().positive(),
      selection: z.array(z.uuid()).max(100),
      preview: preview.nullable(),
      // Optional for clients loaded before the cursor feature was deployed.
      cursor: z
        .object({
          x: z
            .number()
            .min(-WORLD_LIMIT - UNIT)
            .max(WORLD_LIMIT + UNIT),
          y: z
            .number()
            .min(-UNIT)
            .max(HEIGHT_LIMIT + UNIT),
          z: z
            .number()
            .min(-WORLD_LIMIT - UNIT)
            .max(WORLD_LIMIT + UNIT),
        })
        .nullable()
        .optional(),
      sample: z.boolean(),
    })
    .parse(await c.req.json());
  return c.json(
    await transaction(async (client) => {
      const w = await lockAccess(client, a, world, false);
      if (w.generation !== v.generation || w.status !== "open")
        throw new DomainError("Workshop changed");
      const r = await client.query(
        "UPDATE viewer_sessions SET sequence=$5,selection=$6,preview=CASE WHEN $8 THEN $7::jsonb ELSE preview END,preview_at=CASE WHEN $8 THEN clock_timestamp() ELSE preview_at END,cursor=CASE WHEN $8 AND $11 THEN $10::jsonb ELSE cursor END,cursor_at=CASE WHEN $8 AND $11 THEN clock_timestamp() ELSE cursor_at END,generation=$9,expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND world=$2 AND guest=$3 AND session=$4 AND sequence<$5 RETURNING id",
        [
          v.viewer,
          world,
          a.guest,
          a.session,
          v.sequence,
          JSON.stringify(v.selection),
          JSON.stringify(v.preview),
          v.sample,
          v.generation,
          JSON.stringify(v.cursor ?? null),
          v.cursor !== undefined,
        ],
      );
      if (!r.rowCount) {
        const exists = await client.query(
          "SELECT id FROM viewer_sessions WHERE id=$1 AND world=$2 AND guest=$3 AND session=$4",
          [v.viewer, world, a.guest, a.session],
        );
        if (!exists.rowCount)
          throw new DomainError("Viewer expired. Rejoin the workshop.", 410);
      }
      return { serverTime: Date.now() };
    }),
  );
});
app.delete("/api/worlds/:world/viewers/:viewer", async (c) => {
  const a = c.get("identity");
  await pool.query(
    "DELETE FROM viewer_sessions WHERE id=$1 AND world=$2 AND guest=$3 AND session=$4",
    [
      z.uuid().parse(c.req.param("viewer")),
      z.uuid().parse(c.req.param("world")),
      a.guest,
      a.session,
    ],
  );
  return c.json({ ok: true });
});
app.post("/api/worlds/:world/reset", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world"));
  const input = z
    .object({
      generation: z.number().int(),
      starter: z.enum(["rover", "empty"]),
    })
    .parse(await c.req.json());
  return c.json(
    await transaction(async (client) => {
      const s = await client.query(
        "SELECT revoked,expires_at>clock_timestamp() AS valid FROM guest_sessions WHERE id=$1 FOR SHARE",
        [a.session],
      );
      if (!s.rows[0]?.valid || s.rows[0].revoked)
        throw new DomainError("Session expired", 401);
      const { rows } = await client.query(
        "SELECT * FROM worlds WHERE id=$1 FOR UPDATE",
        [world],
      );
      const w = rows[0];
      if (!w || w.owner !== a.guest)
        throw new DomainError("Only the room creator can reset it", 403);
      if (w.generation !== input.generation || w.status !== "open")
        throw new DomainError("Workshop changed");
      const parts = input.starter === "rover" ? starter(randomUUID) : [];
      for (let i = 0; i < parts.length; i++) {
        if (!validPart(parts[i])) throw new Error("Invalid starter");
        for (let j = 0; j < i; j++)
          if (collision(parts[i], parts[j]))
            throw new Error("Starter collision");
      }
      await client.query("DELETE FROM connector_slot_claims WHERE world=$1", [
        world,
      ]);
      await client.query(
        "UPDATE part_connections SET deleted=1,revision=revision+1 WHERE world=$1 AND deleted=0",
        [world],
      );
      await client.query(
        "UPDATE part_instances SET deleted=1,revision=revision+1 WHERE world=$1 AND deleted=0",
        [world],
      );
      for (const p of parts) await insertPart(client, world, p);
      await reconnectParts(client, world, parts, parts, []);
      await client.query(
        "UPDATE worlds SET generation=generation+1 WHERE id=$1",
        [world],
      );
      await client.query(
        "UPDATE viewer_sessions SET preview=NULL,selection=$2,generation=$3 WHERE world=$1",
        [world, JSON.stringify([]), w.generation + 1],
      );
      const tx = await client.query(
        "SELECT pg_current_xact_id()::text AS txid",
      );
      return { generation: w.generation + 1, txid: tx.rows[0].txid };
    }),
  );
});
app.post("/api/worlds/:world/lifecycle", async (c) => {
  const a = c.get("identity"),
    world = z.uuid().parse(c.req.param("world")),
    input = z
      .object({
        generation: z.number().int(),
        status: z.enum(["open", "closed"]),
      })
      .parse(await c.req.json());
  return c.json(
    await transaction(async (client) => {
      const session = await client.query(
        "SELECT revoked,expires_at>clock_timestamp() AND absolute_expiry>clock_timestamp() AS valid FROM guest_sessions WHERE id=$1 AND guest=$2 FOR SHARE",
        [a.session, a.guest],
      );
      if (!session.rows[0]?.valid || session.rows[0].revoked)
        throw new DomainError("Session expired", 401);
      const { rows } = await client.query(
          "SELECT * FROM worlds WHERE id=$1 FOR UPDATE",
          [world],
        ),
        w = rows[0];
      if (!w || w.owner !== a.guest)
        throw new DomainError(
          "Only the creator can close or reopen this workshop",
          403,
        );
      if (w.generation !== input.generation)
        throw new DomainError("Workshop changed");
      await client.query(
        "UPDATE worlds SET status=$2,generation=generation+1,expires_at=CASE WHEN $2='open' THEN clock_timestamp()+interval '24 hours' ELSE expires_at END WHERE id=$1",
        [world, input.status],
      );
      await client.query(
        "UPDATE viewer_sessions SET preview=NULL,selection=$2,generation=$3 WHERE world=$1",
        [world, JSON.stringify([]), w.generation + 1],
      );
      return { generation: w.generation + 1, status: input.status };
    }),
  );
});
app.onError((error, c) => {
  if (error instanceof z.ZodError)
    return c.json(
      { error: "Invalid request", details: error.issues.map((i) => i.message) },
      400,
    );
  if (error instanceof DomainError)
    return c.json(
      { error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 410,
    );
  const code = (error as { code?: string }).code;
  if (["55P03", "57014", "40P01", "40001"].includes(code || ""))
    return c.json({ error: "Workshop busy. Retry this operation." }, 503);
  console.error("[bricks]", error);
  return c.json({ error: "The workshop is temporarily unavailable" }, 500);
});
export default app;
