# Building models with AI

Open the workshop menu and choose **Build with AI**. Describe a small model and wait for a validated 3D preview. You can describe a change and choose **Update model** repeatedly before choosing **Use this model**. Acceptance creates a new collaborative workshop. Generated pieces support normal selection, snapping, recolouring, undo and collaborative editing.

The last valid preview stays visible during an update and remains usable if the update fails or is cancelled. **Start a new model** clears the current draft selection. Closing or reloading the dialog restores the current request and previous preview from session storage.

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

A full row replaces or adds that ID; `row: null` deletes it. Omitted rows are preserved. A patch has at most 40 changes; duplicate changes and mismatched IDs fail validation. Before requesting a repair, a bounded snap pass can move a whole disconnected component onto a nearby stud: at most one stud horizontally and one plate vertically, at most 36 candidate checks. It preserves shapes, colours and repetitions, skips partially anchored repeated rows, and accepts a shift only when full validation improves without creating overlaps. It never removes unsupported details. The recorded attempt includes any automatic shifts. Larger geometry errors still need a model repair.

The model receives named geometric errors and actual compiled extents in its source coordinate frame. The prompt asks it to preserve defining features while fixing fit, and to create real door/window openings and visible architectural detail.

Each generation has at most three model calls, each capped at 12,000 output tokens, within a 150-second deadline. GPT models use low reasoning effort. Compact repetitions and patches reduce output size; actual quality and speed depend on the model and subject. See [QUALIFICATION.md](QUALIFICATION.md) for measured examples and model choice.

## Persistence and concurrency

The browser reserves an operation UUID and starts a bounded HTTP request to the Neon Function. Requests use existing guest authentication. Only that guest can read, subscribe to, cancel or accept their draft. The browser receives no Gateway credential.

Postgres `ai_generations` stores prompt, model, status, canonical blueprint, compact design, per-attempt candidates and issues, elapsed inference time, token counts, source reference and accepted workshop. Each completed inference contributes token usage once. Realtime publishes meaningful progress stages. The dialog renews its capability every 40 seconds, polls every five seconds while busy, and guards against delayed responses reversing cancellation or newer progress.

A refinement reserves a new generation with `source` pointing to a ready or accepted owned draft. Reservation captures an immutable reference snapshot. It refines that draft, not subsequent edits to an accepted workshop. No inference occurs inside a database transaction, and drafts do not change a workshop until acceptance.

Functions can be evicted. Work uses a bounded HTTP invocation, not a durable background queue. A lease expires interrupted jobs into failure; queued requests can resume idempotently. Cancellation is persisted, aborts local inference, and is checked across isolates every two seconds. Late results cannot overwrite cancelled or expired work. The previous valid preview remains available for acceptance.

Acceptance revalidates the canonical blueprint and current session, locks the generation row, and creates workshop, buckets, pieces, connections and claims in one transaction. Local IDs become fresh UUIDs. Concurrent acceptance returns the same workshop. Subsequent edits use existing neighbourhood locks and revision rules; generation never locks a workshop.

## Configuration and limits

`neon.ts` declares `aiGateway: true`. Neon supplies `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` to the Function. For local development, pull them with `npm run neon -- env pull --service ai-gateway --file .env.local`. Keep that file private. The Function uses `@neon/ai-sdk-provider` and AI SDK structured output.

`AI_MODEL` defaults to `gpt-5-4` and selects the Gateway model. Verify availability on the linked staging branch before changing it. The app has no daily or hourly request-count allowance. Neon AI Gateway prepaid credits and spending policy control the budget. Admission permits two active jobs globally and one per guest. A short AI-specific advisory lock serializes concurrency admission. Workshop editing uses different locks.

Providers can charge for inference already performed, including cancelled and interrupted builds. The app shows a budget message only when a Gateway error explicitly identifies depleted credits or an exceeded spending limit. A generic HTTP 429, token-per-minute limit or daily token limit shows a separate busy message. Budget exhaustion does not imply a midnight reset: prepaid credits may need topping up in Neon. Per-build token and deadline bounds remain in place.

The health response includes `aiBuilder`, a source-version marker. Deployment can report completion while the previous Function still serves requests briefly. The benchmark checks both the marker and the model configuration before reserving paid work, with cache-bypassed checks. API responses declare `Cache-Control: no-store`.

## Verification

```sh
npm test
npm run build
npm run test:ai
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
