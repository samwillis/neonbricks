import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  CATALOGUE_VERSION,
  WORLD_LIMIT,
  HEIGHT_LIMIT,
  BUCKET,
  type Part,
} from "../shared/types";
import { bounds, collision, validPart } from "../shared/geometry";
import { starter } from "../shared/starter";
import { transaction } from "./db";
import { DomainError, type Identity } from "./auth";
export const partFromRow = (r: Record<string, any>): Part => ({
  id: r.id,
  key: r.key,
  color: r.color,
  position: { x: r.x, y: r.y, z: r.z },
  rotation: r.rotation,
  revision: r.revision,
  deleted: !!r.deleted,
});
export async function insertPart(c: PoolClient, world: string, p: Part) {
  const b = bounds(p);
  await c.query(
    "INSERT INTO part_instances(id,world,key,color,x,y,z,rotation,revision,deleted,minx,miny,minz,maxx,maxy,maxz) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    [
      p.id,
      world,
      p.key,
      p.color,
      p.position.x,
      p.position.y,
      p.position.z,
      p.rotation,
      p.revision,
      p.deleted ? 1 : 0,
      b.minx,
      b.miny,
      b.minz,
      b.maxx,
      b.maxy,
      b.maxz,
    ],
  );
}
export async function insertWorld(
  c: PoolClient,
  title: string,
  owner: string | null,
  slug?: string,
) {
  const id = randomUUID(),
    name = slug || randomUUID().slice(0, 8);
  const { rows } = await c.query(
    "INSERT INTO worlds(id,slug,title,owner,catalogue) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [id, name, title, owner, CATALOGUE_VERSION],
  );
  const keys: number[][] = [];
  for (
    let x = Math.floor((-WORLD_LIMIT - 2) / BUCKET);
    x <= Math.floor((WORLD_LIMIT + 2) / BUCKET);
    x++
  )
    for (let y = -1; y <= Math.floor((HEIGHT_LIMIT + 2) / BUCKET); y++)
      for (
        let z = Math.floor((-WORLD_LIMIT - 2) / BUCKET);
        z <= Math.floor((WORLD_LIMIT + 2) / BUCKET);
        z++
      )
        keys.push([x, y, z]);
  await c.query(
    "INSERT INTO spatial_buckets(world,x,y,z) SELECT $1,x,y,z FROM unnest($2::int[],$3::int[],$4::int[]) AS b(x,y,z)",
    [id, keys.map((v) => v[0]), keys.map((v) => v[1]), keys.map((v) => v[2])],
  );
  return rows[0];
}
export async function createWorld(
  title: string,
  owner: string | null,
  withStarter: boolean,
  slug?: string,
) {
  return transaction(async (c) => {
    const world = await insertWorld(c, title, owner, slug);
    const id = world.id;
    const parts = withStarter ? starter(randomUUID) : [];
    for (let i = 0; i < parts.length; i++) {
      if (!validPart(parts[i]))
        throw new Error(`Starter outside bounds: ${parts[i].key}`);
      for (let j = 0; j < i; j++)
        if (collision(parts[i], parts[j]))
          throw new Error(
            `Starter collision: ${parts[i].key} / ${parts[j].key}`,
          );
      await insertPart(c, id, parts[i]);
    }
    // Import lazily to keep bootstrap independent of the HTTP app.
    const { reconnectParts } = await import("./commands");
    await reconnectParts(c, id, parts, parts, []);
    return world;
  });
}
export async function joinWorld(a: Identity, slug: string) {
  return transaction(async (c) => {
    const s = await c.query(
      "SELECT revoked,expires_at>clock_timestamp() AND absolute_expiry>clock_timestamp() AS valid FROM guest_sessions WHERE id=$1 AND guest=$2 FOR SHARE",
      [a.session, a.guest],
    );
    if (!s.rows[0]?.valid || s.rows[0].revoked)
      throw new DomainError("Session expired", 401);
    const { rows } = await c.query(
      "SELECT *,expires_at IS NULL OR expires_at>clock_timestamp() AS unexpired FROM worlds WHERE slug=$1 FOR SHARE",
      [slug],
    );
    const w = rows[0];
    if (!w) throw new DomainError("Workshop not found", 404);
    if (w.status !== "open" || !w.unexpired)
      throw new DomainError("This workshop is closed", 403);
    await c.query(
      "INSERT INTO world_memberships(world,guest) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [w.id, a.guest],
    );
    const membership = await c.query(
      "SELECT active FROM world_memberships WHERE world=$1 AND guest=$2 FOR SHARE",
      [w.id, a.guest],
    );
    if (!membership.rows[0].active)
      throw new DomainError("Workshop access denied", 403);
    await c.query(
      "INSERT INTO guest_world_history(world,guest,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [w.id, a.guest, w.generation],
    );
    const viewer = randomUUID();
    await c.query(
      "INSERT INTO viewer_sessions(id,world,guest,session,generation,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 seconds')",
      [viewer, w.id, a.guest, a.session, w.generation],
    );
    return {
      world: w,
      viewer,
      guest: a.guest,
      name: a.name,
      color: a.color,
      canReset: w.owner === a.guest,
      serverTime: Date.now(),
    };
  });
}
