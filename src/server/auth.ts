import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export type Identity = {
  session: string;
  guest: string;
  name: string;
  color: string;
};
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function newSession(name: string, color: string) {
  const guest = randomUUID(),
    session = randomUUID(),
    token = randomBytes(32).toString("base64url");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO guests(id,name,color) VALUES($1,$2,$3)", [
      guest,
      name,
      color,
    ]);
    const { rows } = await c.query(
      "INSERT INTO guest_sessions(id,guest,hash,expires_at,absolute_expiry) VALUES($1,$2,$3,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '24 hours') RETURNING expires_at",
      [session, guest, hash(token)],
    );
    await c.query("COMMIT");
    return { token, guest, name, color, expiresAt: rows[0].expires_at };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function authenticate(
  authorization: string | undefined,
): Promise<Identity> {
  if (!authorization?.startsWith("Bearer "))
    throw new DomainError("Sign in to join the workshop", 401);
  const { rows } = await pool.query(
    "SELECT s.id AS session,s.guest,g.name,g.color FROM guest_sessions s JOIN guests g ON g.id=s.guest WHERE s.hash=$1 AND s.revoked=0 AND s.expires_at>clock_timestamp() AND s.absolute_expiry>clock_timestamp()",
    [hash(authorization.slice(7))],
  );
  if (!rows[0])
    throw new DomainError(
      "Your guest session expired. Rejoin the workshop.",
      401,
    );
  return rows[0];
}
export async function lockAccess(
  c: PoolClient,
  a: Identity,
  world: string,
  editor = true,
) {
  const { rows } = await c.query(
    `SELECT w.*,s.revoked,s.expires_at>clock_timestamp() AND s.absolute_expiry>clock_timestamp() AS valid,
    w.expires_at IS NULL OR w.expires_at>clock_timestamp() AS unexpired,m.role,m.active
    FROM guest_sessions s JOIN worlds w ON w.id=$1 JOIN world_memberships m ON m.world=w.id AND m.guest=s.guest
    WHERE s.id=$2 AND s.guest=$3 FOR SHARE OF s,w,m`,
    [world, a.session, a.guest],
  );
  const w = rows[0];
  if (!w) throw new DomainError("Workshop access denied", 403);
  if (!w.valid || w.revoked) throw new DomainError("Session expired", 401);
  if (editor && (w.status !== "open" || !w.unexpired))
    throw new DomainError("This workshop is closed or expired", 410);
  if (!w.active || (editor && w.role !== "editor"))
    throw new DomainError("Workshop access denied", 403);
  return w as {
    id: string;
    generation: number;
    status: string;
    catalogue: string;
    owner: string;
  };
}
