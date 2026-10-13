import { compileBlueprint, type CompiledBlueprint } from "./blueprint";
import { expandDesign, type Design } from "./design";
import { bounds } from "./geometry";

// Count every issue for comparison, even when the bounded diagnostic list is full.
export function fitScore(compiled: CompiledBlueprint) {
  return Object.entries(compiled.issueCounts).reduce(
    (score, [code, count]) =>
      score + count * (code === "unattached" ? 1 : code === "overlap" ? 4 : 8),
    0,
  );
}

export function fitRepairFeedback(
  compiled: CompiledBlueprint,
  design?: Design,
  retainedPrevious = false,
) {
  // Report coordinates before presentation rotation, matching the source rows.
  const parts = design
    ? compileBlueprint({ ...design, front: "+z" }).parts
    : compiled.parts;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const owner = new Map<string, string>();
  if (design)
    for (const row of design.pieces)
      for (const part of expandDesign({ ...design, pieces: [row] }).parts)
        owner.set(part.id, row.id);
  const extent = (id: string) => {
    const part = byId.get(id);
    if (!part) return { id, row: owner.get(id) || id };
    const b = bounds(part);
    return {
      id,
      row: owner.get(id) || id,
      x: [b.minx / 6, b.maxx / 6],
      y: [b.miny / 2, b.maxy / 2],
      z: [b.minz / 6, b.maxz / 6],
    };
  };
  const diagnostics = compiled.issues.map((issue) => ({
    ...issue,
    pieces: issue.parts.map(extent),
  }));
  return `\nFIT REPAIR: correct the remaining geometry in this draft.
${retainedPrevious ? "The last patch made the fit worse and was discarded. Work from the retained design below, not the discarded patch.\n" : ""}Previous design: ${JSON.stringify(design || compiled.blueprint)}
Full issue counts: ${JSON.stringify(compiled.issueCounts)}
Validation errors and actual extents (x/z studs; y plates): ${JSON.stringify(diagnostics)}
Resolve overlaps first. Compare the named pieces' x, y and z intervals: touching endpoints are fine, occupied volume in common is not. Rotated dimensions are already reflected in the extents. Fix the named SOURCE ROWS; a repeated piece or assembly may expand into several named components.
For wall corners, shorten or split the competing courses so only one wall owns the corner. For windows and arches, leave a real opening; split repeat rows that run through it. For stair landings, stop the stairs at the deck edge or leave a matching opening in the deck/floor. Do not move an entire wall into the roof or other valid pieces to hide one collision.
Then connect floating components to supported surfaces or ground them. Ground-level scenery outside the base must start at y=0; use y=1 only when a plate actually supports it. A plate stair tread is only one plate tall: do not stack the next tread across a gap without a supported riser.
Keep the requested features, palette, silhouette and unaffected rows. Check every changed row against its neighbours; do not trade one fit error for another. ${design ? "Return only a patch; keep unaffected rows." : "Return a complete corrected version 2 design."}`;
}

export function fitFailureMessage(compiled?: CompiledBlueprint) {
  if (!compiled)
    return "AI returned an incomplete design after three passes. Your model is unchanged. Please try building again.";
  const overlap = compiled.issueCounts.overlap || 0;
  const unsupported = compiled.issueCounts.unattached || 0;
  const problems: string[] = [];
  if (overlap)
    problems.push(
      `${overlap} overlapping piece ${overlap === 1 ? "pair" : "pairs"}`,
    );
  if (unsupported)
    problems.push(
      `${unsupported} ${unsupported === 1 ? "piece" : "pieces"} without support`,
    );
  if (!problems.length)
    problems.push("invalid piece placements or connections");
  return `The draft still has ${problems.join(" and ")} after three design passes. Your model is unchanged. Please try building again.`;
}
