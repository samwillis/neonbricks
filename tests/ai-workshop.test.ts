import { describe, expect, it } from "vitest";
import {
  aiWorkshopEdit,
  streamingPreview,
  workshopReference,
  sameAISnapshot,
  type AISnapshot,
} from "../src/shared/ai-workshop";
import { compileBlueprint } from "../src/shared/blueprint";
import { designSchema } from "../src/shared/design";
const row = {
  id: "base",
  part: "brick-1x1",
  colour: "jade",
  turn: 0,
  at: [0, 0, 0],
  repeat: null,
};
const snapshot: AISnapshot = {
  generation: 2,
  title: "My model",
  parts: [
    {
      id: "real-base",
      key: "brick-1x1",
      color: "#289b74",
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      revision: 4,
    },
    {
      id: "real-top",
      key: "brick-1x1",
      color: "#289b74",
      position: { x: 0, y: 6, z: 0 },
      rotation: 0,
      revision: 7,
    },
  ],
  connections: [
    {
      id: "edge",
      a: "real-base",
      b: "real-top",
      ca: "top",
      cb: "bottom",
      revision: 2,
    },
  ],
};
describe("Workshop AI drafts", () => {
  it("compares Postgres JSON snapshots independently of object key and row order", () => {
    const stored = {
      ...snapshot,
      parts: snapshot.parts
        .map((p) => ({
          revision: p.revision,
          rotation: p.rotation,
          position: { z: p.position.z, y: p.position.y, x: p.position.x },
          color: p.color,
          key: p.key,
          id: p.id,
        }))
        .reverse(),
    };
    expect(sameAISnapshot(snapshot, stored)).toBe(true);
    expect(sameAISnapshot(snapshot, { ...stored, generation: 3 })).toBe(false);
    expect(
      sameAISnapshot(snapshot, {
        ...stored,
        parts: stored.parts.map((p, i) =>
          i ? p : { ...p, revision: p.revision + 1 },
        ),
      }),
    ).toBe(false);
    expect(sameAISnapshot(snapshot, { ...stored, connections: [] })).toBe(
      false,
    );
  });
  it("draws complete rows from a partial stream and omits unfinished pieces", () => {
    const drawing = streamingPreview({
      title: "Tower",
      front: "+z",
      pieces: [row, { id: "cap", part: "brick-1x1" }],
    });
    expect(drawing?.parts).toHaveLength(1);
    expect(drawing?.parts[0].position).toEqual({ x: 0, y: 0, z: 0 });
    expect(streamingPreview({ pieces: [{ ...row, turn: 9 }] })).toBeNull();
    expect(
      streamingPreview({
        pieces: [{ ...row, repeat: { count: 32, step: [1, 0, 0] } }],
      }),
    ).toBeNull();
  });
  it("streams patches without dropping unaffected rows or applying incomplete changes", () => {
    const previous = designSchema.parse(workshopReference(snapshot));
    const patch = {
      changes: [
        { id: "p1", row: { ...previous.pieces[1], colour: "cobalt" } },
        { id: "p0", row: { id: "p0" } },
      ],
    };
    const drawing = streamingPreview(patch, previous);
    expect(drawing?.parts).toHaveLength(2);
    expect(drawing?.parts.find((p) => p.id === "p0")?.color).toBe("#289b74");
    expect(drawing?.parts.find((p) => p.id === "p1")?.color).toBe("#486fa4");
    expect(
      streamingPreview({ changes: [{ id: "p0", row: {} }] }, previous),
    ).toBeNull();
  });
  it("captures exact current placements and retains real part IDs for edits", () => {
    const reference = designSchema.parse(workshopReference(snapshot));
    const compiled = compileBlueprint(reference);
    expect(compiled.issues).toEqual([]);
    const parts = compiled.parts.map((p) =>
      p.id === "p1" ? { ...p, color: "#486fa4" } : p,
    );
    const edit = aiWorkshopEdit(snapshot, parts, "operation", () => "new-id");
    expect(edit.generation).toBe(2);
    expect(edit.changes).toEqual([
      {
        id: "real-top",
        expected: 7,
        key: "brick-1x1",
        color: "#486fa4",
        position: { x: 0, y: 6, z: 0 },
        rotation: 0,
      },
    ]);
    expect(edit.connections).toEqual([{ id: "edge", revision: 2 }]);
    expect(
      aiWorkshopEdit(snapshot, compiled.parts, "operation", () => "new")
        .changes,
    ).toEqual([]);
  });
  it("includes deletion revisions and incident connectors in a replacement", () => {
    const replacement = compileBlueprint({
      version: 2,
      title: "New",
      summary: "New",
      pieces: [{ ...row, id: "new" }],
    }).parts;
    const edit = aiWorkshopEdit(
      snapshot,
      replacement,
      "operation",
      () => "replacement",
    );
    expect(edit.changes?.map((c) => c.id)).toEqual([
      "replacement",
      "real-base",
      "real-top",
    ]);
    expect(edit.changes?.slice(1)).toEqual([
      { id: "real-base", expected: 4, deleted: true },
      { id: "real-top", expected: 7, deleted: true },
    ]);
  });
  it("handles empty and larger workshop references without truncating the model", () => {
    expect(workshopReference({ ...snapshot, parts: [] })).toBeNull();
    const ref = workshopReference({
      ...snapshot,
      parts: Array.from({ length: 101 }, (_, i) => ({
        ...snapshot.parts[0],
        id: `part-${i}`,
      })),
    }) as { version: number; parts: unknown[] };
    expect(ref.version).toBe(1);
    expect(ref.parts).toHaveLength(101);
  });
});
