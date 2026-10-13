import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export const worlds = pgTable("worlds", {
  id: uuid().primaryKey(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  owner: uuid(),
  generation: integer().notNull().default(1),
  catalogue: text().notNull(),
  status: text().notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).default(
    sql`now()+interval '24 hours'`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: uuid().primaryKey(),
    guest: uuid().notNull(),
    session: uuid(),
    prompt: text().notNull(),
    model: text().notNull(),
    status: text().notNull().default("queued"),
    attempt: integer().notNull().default(0),
    blueprint: jsonb(),
    design: jsonb(),
    source: uuid(),
    reference: jsonb(),
    target: uuid().references(() => worlds.id),
    snapshot: jsonb(),
    preview: jsonb(),
    activity: text(),
    previewVersion: integer("preview_version").notNull().default(0),
    attempts: jsonb().notNull().default({}),
    issues: jsonb(),
    error: text(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    world: uuid().references(() => worlds.id),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_generations_guest_created").on(t.guest, t.createdAt),
    index("ai_generations_status_lease").on(t.status, t.leaseUntil),
    index("ai_generations_target_created").on(t.target, t.createdAt, t.id),
    index("ai_generations_legacy_created")
      .on(t.world, t.guest, t.createdAt, t.id)
      .where(sql`${t.target} IS NULL`),
  ],
);
export const guests = pgTable("guests", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  color: text().notNull(),
});
export const sessions = pgTable("guest_sessions", {
  id: uuid().primaryKey(),
  guest: uuid()
    .notNull()
    .references(() => guests.id),
  hash: text().notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteExpiry: timestamp("absolute_expiry", {
    withTimezone: true,
  }).notNull(),
  revoked: integer().notNull().default(0),
});
export const memberships = pgTable(
  "world_memberships",
  {
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    guest: uuid()
      .notNull()
      .references(() => guests.id),
    role: text().notNull().default("editor"),
    active: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.world, t.guest] })],
);
export const parts = pgTable(
  "part_instances",
  {
    id: uuid().primaryKey(),
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    key: text().notNull(),
    color: text().notNull(),
    x: integer().notNull(),
    y: integer().notNull(),
    z: integer().notNull(),
    rotation: integer().notNull(),
    revision: integer().notNull(),
    deleted: integer().notNull().default(0),
    minx: integer().notNull(),
    miny: integer().notNull(),
    minz: integer().notNull(),
    maxx: integer().notNull(),
    maxy: integer().notNull(),
    maxz: integer().notNull(),
  },
  (t) => [
    index("parts_world_bounds")
      .on(t.world, t.minx, t.maxx)
      .where(sql`${t.deleted}=0`),
  ],
);
export const connections = pgTable(
  "part_connections",
  {
    id: uuid().primaryKey(),
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    a: uuid()
      .notNull()
      .references(() => parts.id),
    b: uuid()
      .notNull()
      .references(() => parts.id),
    ca: text().notNull(),
    cb: text().notNull(),
    revision: integer().notNull(),
    deleted: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("connection_pair").on(t.world, t.a, t.b, t.ca, t.cb),
    index("connections_a").on(t.world, t.a),
    index("connections_b").on(t.world, t.b),
  ],
);
export const claims = pgTable(
  "connector_slot_claims",
  {
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    part: uuid()
      .notNull()
      .references(() => parts.id),
    slot: text().notNull(),
    connection: uuid()
      .notNull()
      .references(() => connections.id),
  },
  (t) => [primaryKey({ columns: [t.world, t.part, t.slot] })],
);
export const buckets = pgTable(
  "spatial_buckets",
  {
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    x: integer().notNull(),
    y: integer().notNull(),
    z: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.world, t.x, t.y, t.z] })],
);
export const viewers = pgTable(
  "viewer_sessions",
  {
    id: uuid().primaryKey(),
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    guest: uuid()
      .notNull()
      .references(() => guests.id),
    session: uuid()
      .notNull()
      .references(() => sessions.id),
    generation: integer().notNull(),
    selection: jsonb().notNull().default([]),
    preview: jsonb(),
    cursor: jsonb(),
    sequence: integer().notNull().default(0),
    previewAt: timestamp("preview_at", { withTimezone: true }),
    cursorAt: timestamp("cursor_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("viewers_expiry").on(t.world, t.expiresAt)],
);
export const operations = pgTable(
  "build_operations",
  {
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    guest: uuid()
      .notNull()
      .references(() => guests.id),
    id: uuid().notNull(),
    generation: integer().notNull(),
    digest: text().notNull(),
    receipt: jsonb(),
    before: jsonb(),
    after: jsonb(),
    beforeConnections: jsonb("before_connections"),
    afterConnections: jsonb("after_connections"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.world, t.guest, t.id] })],
);
export const histories = pgTable(
  "guest_world_history",
  {
    world: uuid()
      .notNull()
      .references(() => worlds.id),
    guest: uuid()
      .notNull()
      .references(() => guests.id),
    generation: integer().notNull(),
    undo: jsonb().notNull().default([]),
    redo: jsonb().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.world, t.guest] })],
);
