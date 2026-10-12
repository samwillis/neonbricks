import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@neon/functions";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const connection = new URL(url);
if (
  !connection.hostname.includes("localhost") &&
  connection.hostname !== "127.0.0.1"
)
  connection.searchParams.set("sslmode", "verify-full");
export const pool = new Pool({
  connectionString: connection.toString(),
  max: 8,
  connectionTimeoutMillis: 15_000,
  ssl:
    url.includes("localhost") || url.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: true },
});
attachDatabasePool(pool);
export async function transaction<T>(
  run: (c: PoolClient) => Promise<T>,
): Promise<T> {
  for (let n = 0; ; n++) {
    const c = await pool.connect();
    try {
      await c.query(
        "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout='2500ms'; SET LOCAL statement_timeout='15000ms'",
      );
      const r = await run(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      if (
        n < 2 &&
        ["40P01", "40001"].includes((e as { code?: string }).code || "")
      )
        continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
