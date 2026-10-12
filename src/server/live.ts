import { createRealtime, rawSql } from "@neon/realtime/server";
import type { SceneRow, Viewer } from "../shared/types";
import type { Identity } from "./auth";
export function realtime() {
  const secret = process.env.REALTIME_SECRET;
  if (!secret) throw new Error("REALTIME_SECRET is required");
  return createRealtime({
    secret,
    db: decodeURIComponent(
      new URL(process.env.DATABASE_URL!).pathname.slice(1),
    ),
  });
}
const access = `EXISTS(SELECT 1 FROM world_memberships m JOIN guest_sessions s ON s.guest=m.guest WHERE m.world=$1::uuid AND m.guest=$2::uuid AND m.active=1 AND s.id=$3::uuid AND s.revoked=0)`;
export function sceneQuery(world: string, a: Identity) {
  return rawSql<SceneRow>(
    `
    SELECT 'world'::text AS kind,w.id::text AS id,w.slug,w.title,w.generation,w.catalogue,w.status,
      NULL::text AS key,NULL::text AS color,NULL::int AS x,NULL::int AS y,NULL::int AS z,NULL::int AS rotation,NULL::int AS revision,
      NULL::text AS a,NULL::text AS b,NULL::text AS ca,NULL::text AS cb FROM worlds w WHERE w.id=$1::uuid AND ${access}
    UNION ALL
    SELECT 'part'::text,p.id::text,NULL::text,NULL::text,NULL::int,NULL::text,NULL::text,
      p.key,p.color,p.x,p.y,p.z,p.rotation,p.revision,NULL::text,NULL::text,NULL::text,NULL::text FROM part_instances p WHERE p.world=$1::uuid AND p.deleted=0 AND ${access}
    UNION ALL
    SELECT 'connection'::text,e.id::text,NULL::text,NULL::text,NULL::int,NULL::text,NULL::text,
      NULL::text,NULL::text,NULL::int,NULL::int,NULL::int,NULL::int,e.revision,e.a::text,e.b::text,e.ca,e.cb FROM part_connections e WHERE e.world=$1::uuid AND e.deleted=0 AND ${access}
  `,
    [world, a.guest, a.session],
  );
}
export function presenceQuery(world: string, a: Identity) {
  return rawSql<Viewer>(
    `SELECT v.id::text,v.guest::text,g.name,g.color,v.selection,v.preview,v.generation,v.preview_at::text,v.expires_at::text FROM viewer_sessions v JOIN guests g ON g.id=v.guest WHERE v.world=$1::uuid AND ${access}`,
    [world, a.guest, a.session],
  );
}
export function historyQuery(world: string, a: Identity) {
  return rawSql<{ undo: string | null; redo: string | null }>(
    `SELECT CASE WHEN h.generation=w.generation THEN h.undo->-1->>'id' ELSE NULL END AS undo,CASE WHEN h.generation=w.generation THEN h.redo->-1->>'id' ELSE NULL END AS redo FROM guest_world_history h JOIN worlds w ON w.id=h.world WHERE h.world=$1::uuid AND h.guest=$2::uuid AND ${access}`,
    [world, a.guest, a.session],
  );
}
