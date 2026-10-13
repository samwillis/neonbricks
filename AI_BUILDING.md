# Building models with AI

Open the workshop menu and choose **Build with AI**. A prompt opens a new blank workshop immediately. Completed design rows appear on its canvas as Gateway structured output streams through Postgres and Realtime. The side chat shows drawing counts, elapsed time, collision/connection checks and repair passes. These are draft previews; generated pieces enter the collaborative model only when you choose **Apply to model**.

The header's **AI** button opens the chat in any workshop. Follow-up prompts use a snapshot of the current model, including manual edits, or refine an unapplied draft. **Keep current** sets aside the preview; **Stop** cancels active work. The last valid draft remains usable if a newer update fails. The conversation belongs to the workshop and persists in Postgres with an author on every prompt. All current workshop members see its latest 50 exchanges and the same live draft, including on another device. Closing the panel or reloading restores the conversation. Editors can prompt, stop, refine or apply drafts; viewers can follow along. Applied edits are shared with collaborators and support normal selection, snapping, recolouring and undo.

## Compact design contract

Inference produces a version 2 design. Horizontal coordinates use studs; vertical coordinates use plate heights. One ordinary brick is three plates high. `at` identifies the minimum corner of the **rotated bounding box**. `turn` is a quarter-turn yaw from 0 to 3; odd turns swap width and depth. Coordinates compile to integer database units `[x * 6, y * 2, z * 6]`. New designs declare `front` as `+z`, `-z`, `+x` or `-x`, matching their doorway, face or headlights. Compilation rotates the entire model so those details face the default camera; the source retains its original coordinate frame for refinements. Previously saved designs without `front` keep their poses.

```json
{
  "version": 2,
  "title": "Little lookout",
  "summary": "A jade tower with a red pitched roof.",
  "front": "+z",
  "pieces": [
    {
      "id": "floor",
      "part": "plate-4x4",
      "colour": "sand",
      "turn": 0,
      "at": [-2, 0, -2],
      "repeat": null
    },
    {
      "id": "tower",
      "part": "brick-2x2",
      "colour": "jade",
      "turn": 0,
      "at": [-1, 1, -1],
      "repeat": { "count": 4, "step": [0, 3, 0] }
    },
    {
      "id": "roof",
      "part": "gable-roof",
      "colour": "poppy",
      "turn": 0,
      "at": [-2, 13, -2],
      "repeat": null
    }
  ]
}
```

A repeated row expands at `at + i * step`. Repetition keeps the same orientation and colour. The source allows up to 100 rows and 32 instances per repeated row, with a hard limit of **240 expanded pieces**. IDs such as `tower_0` and `roof_front1` make validation errors traceable to source rows.

The catalogue includes ordinary pieces plus verified shortcuts:

| Assembly             | Composition                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `gable-roof`         | A 4 × 4 plate and four slopes meeting at a ridge; repeat along the ridge for a wider roof |
| `pine-tree`          | Brown round-brick trunk and tapered, layered green branches                               |
| `four-wheel-chassis` | Two fitted axles, four tyres, bearings, cross-decks and a connected 4 × 4 body platform   |
| `upright-cross`      | A supported vertical cross of bricks and plates, for static windmill blades or signs      |
| `wheel-axle`         | Two tyres, one axle and two fitted bearing mounts, with a supported deck location         |
| `gear-pair`          | A fitted 12/20-tooth gear pair                                                            |
| `hinge-pair`         | Two fitted coplanar hinge leaves                                                          |

`src/shared/design.ts` expands these into ordinary version 1 blueprint pieces. Assemblies are authoring conveniences; they do not create special database objects or promise moving mechanisms. Every expanded pose is checked through the same geometry compiler. Template offsets and internal rotations work through all four yaws. Some components have fixed material colours, such as tyres and trunks.

## Validation and repair

`src/shared/blueprint.ts` validates coordinate alignment, board bounds, occupied-cell collisions and exclusive connector claims. Every piece needs a supported path to the board, through actual connectors or sufficient contact with a supported upward surface. Surface support also permits a deck to rest on mechanical bearings. Those support relationships never become invented stud/socket connections. Separate grounded objects are allowed.

This establishes assembly quality, not physical stability, centre-of-mass balance, simulation or resistance to movement. The board remains 32 × 32 studs and 48 plates high. All colours come from the twelve-colour editor palette. Invalid candidates are never offered for acceptance.

The stored canonical format remains version 1 for compatibility: `catalogue: "workshop-1"`, `parts`, and `at` or an authored `attach` reference. Each part supplies one placement method and sets the other to null. Attachments are solved from connector IDs; forward references work and cycles fail. Existing version 1 drafts can still be accepted or converted during refinement.

Initial inference uses structured output for the compact design. Repairs and refinements use a bounded patch:

```json
{
  "title": null,
  "summary": "A tower with a blue roof.",
  "changes": [
    {
      "id": "roof",
      "row": {
        "id": "roof",
        "part": "gable-roof",
        "colour": "cobalt",
        "turn": 0,
        "at": [-2, 13, -2],
        "repeat": null
      }
    }
  ]
}
```

A full row replaces or adds that ID; `row: null` deletes it. Omitted rows are preserved. A patch has at most 40 changes; duplicate changes and mismatched IDs fail validation. Before requesting a repair, a bounded snap pass can move a whole disconnected component onto a nearby stud: at most one stud horizontally and one plate vertically, at most 36 candidate checks. It can also ground scenery one plate above bare board, even when unrelated overlaps remain. It preserves shapes, colours and repetitions, skips conflicted components and partially anchored repeated rows, and accepts a shift only when full validation improves without adding other fit errors. It never removes unsupported details. The recorded attempt includes any automatic shifts. Larger geometry errors still need a model repair.

The model receives named geometric errors, their source-row IDs and actual compiled extents in its source coordinate frame. Feedback explains wall-corner ownership, splitting repeat courses around openings, and keeping stairs clear of deck landings. The prompt asks it to preserve defining features while fixing fit. Small requests aim for 30–70 pieces with modest optional scenery.

Each repair starts from the best fitting draft so far. A weighted score uses every detected issue, with overlaps and other geometry errors weighted above unsupported pieces; the diagnostic examples remain capped at 30. Worse or equally scored patches are discarded. Invalid schema or expansion cannot replace the retained source. Postgres keeps the retained blueprint in the canonical columns and the actual candidate, counts, retention decision and token usage in each attempt. Failed builds report the remaining overlap/support counts and preserve the live workshop.

Each generation has at most three model calls, each capped at 12,000 output tokens, within a 150-second deadline. GPT models use low reasoning effort for initial designs and user refinements, and medium for geometry repairs. Compact repetitions and patches reduce output size; actual quality and speed depend on the model and subject. See [QUALIFICATION.md](QUALIFICATION.md) for measured examples and model choice.

## Persistence and concurrency

The browser reserves an operation UUID and starts a bounded HTTP request to the Neon Function. Requests use existing guest authentication. Workshop membership permits reading and subscribing to workshop drafts; editor membership permits starting, cancelling and accepting them. Drafts without a target workshop retain their original author-only access. The browser receives no Gateway credential.

Postgres `ai_generations` stores prompt, model, status, canonical blueprint, compact design, per-attempt candidates and issues, elapsed inference time, token counts, source reference, target workshop, scene snapshot and streamed drawing. Each completed inference contributes token usage once. Completed design rows or patch changes are published at most once every 800 ms, with actual activity text and a preview revision. Realtime carries drawing updates directly from the JSON column. The panel subscribes to the complete workshop conversation, including new requests from other authors, with a renewable sealed capability. New prompts, progress, previews and final results all render from that live query; HTTP responses do not overwrite its snapshots. A read every five seconds while busy expires evicted work. Membership withdrawal or session revocation removes rows from the query; a denied renewal clears the visible conversation. Invalid or incomplete schema rows are never drawn; a partial drawing can still have fit issues until final validation.

A workshop prompt captures parts, revisions, connections and generation in one SQL statement. Up to 100 existing pieces become compact rows with stable local IDs, so patches preserve their database identities. Larger models use a complete version 1 reference without truncation. A refinement can reserve a generation with `source` pointing to a ready draft in the same workshop; it then inherits that draft's original workshop snapshot. After application, the next prompt snapshots the live workshop again. No inference occurs inside a database transaction, and drafts do not change workshop pieces until acceptance.

Functions can be evicted. Work uses a bounded HTTP invocation, not a durable background queue. A lease expires interrupted jobs into failure; queued requests can resume idempotently. Cancellation is persisted, aborts local inference, and is checked across isolates every two seconds. Late results cannot overwrite cancelled or expired work. The previous valid preview remains available for acceptance.

Acceptance revalidates the blueprint, session and workshop access, then checks the captured scene against the live model. A concurrent edit or reset rejects stale application. The generation row, normal edit receipt, pieces, connections, claims and undo history commit in one transaction. Changed existing pieces keep their IDs; added pieces get fresh UUIDs. The same spatial buckets and part/connector revision rules used by manual editing handle conflicts after lock waits. AI apply/compensation permits up to 480 changes for a complete 240-piece replacement; the browser's manual edit API remains capped at 100 changes. Concurrent acceptance returns the same workshop. Old drafts without a target retain the previous create-a-workshop acceptance path.

## Configuration and limits

`neon.ts` declares `aiGateway: true`. Neon supplies `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` to the Function. For local development, pull them with `npm run neon -- env pull --service ai-gateway --file .env.local`. Keep that file private. The Function uses `@neon/ai-sdk-provider` and AI SDK structured output.

`AI_MODEL` defaults to `gpt-5-4` and selects the Gateway model. Verify availability on the linked staging branch before changing it. The app has no daily or hourly request-count allowance. Neon AI Gateway prepaid credits and spending policy control the budget. Admission permits two active jobs globally, one per guest and one per workshop. A short AI-specific advisory lock serializes concurrency admission. Workshop editing uses different locks.

Providers can charge for inference already performed, including cancelled and interrupted builds. The app shows a budget message only when a Gateway error explicitly identifies depleted credits or an exceeded spending limit. A generic HTTP 429, token-per-minute limit or daily token limit shows a separate busy message. Budget exhaustion does not imply a midnight reset: prepaid credits may need topping up in Neon. Per-build token and deadline bounds remain in place.

The health response includes `aiBuilder`, a source-version marker. Deployment can report completion while the previous Function still serves requests briefly. The benchmark checks both the marker and the model configuration before reserving paid work, with cache-bypassed checks. API responses declare `Cache-Control: no-store`.

## Verification

```sh
npm test
npm run build
npm run test:ai
npm run test:ai:workshop
```

The default integration test makes no paid inference calls. It verifies access isolation, Realtime progress, real SQL attempt recording, usage accounting, reference ownership/snapshotting, idempotency, concurrent acceptance, topology, normal editing, cancellation, invalid-candidate rollback and lease expiry. It closes its disposable workshop and deletes only its own synthetic job records. Unit tests cover compact expansion, assembly yaws, explicit front orientation, actual surface support, patch preservation, bounded repair, small stud-placement correction using a real failed rover fixture, and response ordering.

For a paid generation test:

```sh
npm run test:ai -- --generate-only
AI_BENCH_CASES=cabin,rover,castle,dinosaur,treehouse,windmill \
AI_BENCH_LABEL=current npm run test:ai:benchmark
```

The benchmark uses fresh guests, at most two simultaneous builds, and the normal application's reservation, validation and acceptance paths. It never retries a failed case automatically. Results and diagnostics are saved under ignored `artifacts/ai-benchmark-<label>/`; accepted workshops stay available for visual review. `AI_TEST_PROMPT` selects the single-test prompt. Inspect silhouettes and requested features as well as validation and timing; a geometric pass alone does not establish good model quality.

## Extensions

Editing an existing workshop needs a captured scene/revision snapshot, a preview of the proposed edits, and final collision/revision checks under spatial locks. Image references and moving mechanisms require separate qualification. The design format does not imply motors, free-angle rotation or simulation.
