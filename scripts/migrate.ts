import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) throw new Error("DATABASE_URL_UNPOOLED required");
const connection = new URL(url);
connection.searchParams.set("sslmode", "verify-full");
const p = new Pool({
  connectionString: connection.toString(),
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});
await migrate(drizzle(p), { migrationsFolder: "./drizzle" });
// Full replica identity makes live predicates and updates explicit in WAL.
for (const table of [
  "worlds",
  "guests",
  "guest_sessions",
  "world_memberships",
  "part_instances",
  "part_connections",
  "viewer_sessions",
  "guest_world_history",
])
  await p.query(`ALTER TABLE ${table} REPLICA IDENTITY FULL`);
const { rows } = await p.query("SELECT id FROM worlds WHERE slug='workshop'");
if (!rows.length) {
  const { createWorld } = await import("../src/server/worlds");
  await createWorld("The little workshop", null, true, "workshop");
  const { pool } = await import("../src/server/db");
  await pool.end();
}
await p.query("UPDATE worlds SET expires_at=NULL WHERE slug='workshop'");
console.log("Migrations applied; validated starter workshop is ready.");
await p.end();
