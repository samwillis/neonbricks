export type Position = { x: number; y: number; z: number };
export type Part = {
  id: string;
  key: string;
  color: string;
  position: Position;
  rotation: number;
  revision: number;
  deleted?: boolean;
};
export type Connection = {
  id: string;
  a: string;
  b: string;
  ca: string;
  cb: string;
  revision: number;
};
export type World = {
  id: string;
  slug: string;
  title: string;
  generation: number;
  catalogue: string;
  status: string;
};
export type SceneRow = {
  kind: string;
  id: string;
  slug: string;
  title: string;
  generation: number;
  catalogue: string;
  status: string;
  key: string;
  color: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  revision: number;
  a: string;
  b: string;
  ca: string;
  cb: string;
};
export function sceneEntity(r: SceneRow): World | Part | Connection {
  if (r.kind === "world")
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      generation: r.generation,
      catalogue: r.catalogue,
      status: r.status,
    };
  if (r.kind === "part")
    return {
      id: r.id,
      key: r.key,
      color: r.color,
      position: { x: r.x, y: r.y, z: r.z },
      rotation: r.rotation,
      revision: r.revision,
    };
  return { id: r.id, a: r.a, b: r.b, ca: r.ca, cb: r.cb, revision: r.revision };
}
export type Preview = {
  key: string;
  color: string;
  position: Position;
  rotation: number;
};
export type Viewer = {
  id: string;
  guest: string;
  name: string;
  color: string;
  selection: string[];
  preview: Preview | null;
  generation: number;
  preview_at: string | null;
  expires_at: string;
};
export type Edit = {
  operationId: string;
  generation: number;
  action: "edit" | "undo" | "redo";
  target?: string;
  changes?: {
    id: string;
    expected?: number;
    key?: string;
    color?: string;
    position?: Position;
    rotation?: number;
    deleted?: boolean;
  }[];
  connections?: { id: string; revision: number }[];
};
export type Receipt = {
  accepted: boolean;
  operationId: string;
  generation: number;
  txid?: string;
  error?: string;
  parts?: Part[];
  history?: { undo: string | null; redo: string | null };
};
export const UNIT = 6;
export const CATALOGUE_VERSION = "workshop-1";
export const WORLD_LIMIT = 96;
export const HEIGHT_LIMIT = 96;
export const BUCKET = 24;
