# Building models with AI

Open the workshop menu and choose **Build with AI**. Describe a small model, wait for its validated preview, then choose **Use this model**. Acceptance creates a new workshop; it does not replace the workshop currently open. Generated pieces support the usual selection, snapping, recolouring, undo and collaborative editing.

## Blueprint contract

The source format is versioned JSON for the `workshop-1` catalogue. Horizontal coordinates use studs; vertical coordinates use plate heights. One ordinary brick is three plates high. Coordinates identify the minimum corner of the rotated bounding box. `turn` is a quarter-turn yaw from 0 to 3, with odd turns swapping width and depth. The compiler converts to integer database units: `[x * 6, y * 2, z * 6]`.

```json
{
  "version": 1,
  "catalogue": "workshop-1",
  "title": "Little lookout",
  "summary": "A jade tower with a red roof.",
  "parts": [
    {
      "id": "base",
      "part": "plate-4x4",
      "colour": "sand",
      "turn": 0,
      "at": [-2, 0, -2],
      "attach": null
    },
    {
      "id": "tower",
      "part": "brick-2x2",
      "colour": "jade",
      "turn": 0,
      "at": [-1, 1, -1],
      "attach": null
    },
    {
      "id": "roof",
      "part": "slope-2x2",
      "colour": "poppy",
      "turn": 0,
      "at": [-1, 4, -1],
      "attach": null
    }
  ]
}
```

Each piece must use either `at` or `attach`, setting the other to `null`. Attachments reference a named draft piece and authored connector IDs:

```json
{
  "id": "top",
  "part": "brick-1x1",
  "colour": "jade",
  "turn": 0,
  "at": null,
  "attach": { "to": "tower", "connector": "s0:0", "ownConnector": "b0:0" }
}
```

The compiler solves the translation at the specified turn and verifies connector compatibility. Forward references work; cycles fail. Part IDs are local labels, not database IDs. The server maps them to fresh UUIDs at acceptance and derives connections and exclusive slot claims. Colours come from the existing twelve-colour palette.

`src/shared/blueprint.ts` owns the schema and compiler. It limits a draft to 100 pieces, rejects unsupported catalogue or format versions, and checks exact coordinate alignment, bounds, occupied-cell collisions, connector claims and connection paths to a part resting on the board. Separate grounded objects are allowed. This is an assembly-quality check, not a structural or physics simulation. Mechanical components remain static and have the same connector limitations as the editor.

The Gateway requires a homogeneous array schema for coordinates: JSON Schema tuple arrays were rejected by its native structured-output endpoint. The local schema still requires exactly three numbers.

## Generation and persistence

The browser creates a request with an operation UUID, then starts a bounded HTTP request to the Neon Function. All routes use the existing guest authentication. Only the requesting guest can read, subscribe to, cancel or accept the draft. The browser receives no Gateway credential.

`ai_generations` in Postgres stores the prompt, model, blueprint, validation issues, stage, attempts, token usage, timestamps and accepted workshop. A separate Realtime query publishes meaningful stage changes. The dialog renews its capability every 40 seconds and also polls every five seconds while busy to detect missed events and expired work. Closing and reopening the dialog restores the current job from session storage. Queued work can be resumed with an idempotent run request.

The Function requests structured output through `@neon/ai-sdk-provider` and the AI SDK. Catalogue dimensions and connector metadata are generated from the same definitions used by the editor. Invalid geometry receives named errors and the actual compiled extents for repair. There are at most three model calls, each capped at 16,000 output tokens including reasoning, within a 150-second generation deadline. No inference takes place inside a database transaction.

Functions can be evicted. This feature uses a bounded HTTP invocation, not an assumed durable background queue. A lease expires interrupted work into a failed state; the user can retry. Cancellation is persisted and aborts the inference request, with cross-isolate cancellation checked every two seconds. An already accepted draft stays accepted. Late inference results cannot overwrite cancelled or expired jobs.

Acceptance revalidates the blueprint and current session, locks the generation row and creates the workshop header, spatial buckets, pieces, connections and slot claims in one transaction. Bulk inserts keep the transaction small. Concurrent acceptance requests return the same workshop. Subsequent edits use the existing neighbourhood locks and revision rules. There is no world lock held during generation.

## Configuration and limits

`neon.ts` declares `aiGateway: true`. Neon supplies `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` to the Function. For local development, pull them using `npm run neon -- env pull --service ai-gateway --file .env.local`. Keep `.env.local` private.

`AI_MODEL` defaults to `gpt-5-4`, with medium reasoning effort on the OpenAI route. Verify the model on the linked staging branch's `/v1/models` before changing it. `AI_DAILY_LIMIT` defaults to 40 generation reservations per rolling 24 hours. There are at most two active generations globally, one per guest, and eight new requests per guest per hour. Budget reservations use a brief AI-specific advisory lock; workshop editing does not use that lock.

These are request and token bounds, not a guarantee of a particular dollar bill. Cancelled and interrupted requests still consume their reservation, and providers can charge for inference already performed. Paid inference and model availability depend on the branch's Gateway access and credits.

## Verification

```sh
npm test
npm run build
npm run test:ai
```

The default integration test uses disposable authored fixtures and makes no inference calls. It checks authentication, Realtime progress, quota reservations, concurrent acceptance, topology, normal edits, cancellation, validation rollback and lease expiry. It closes the fixture workshop. Unit tests exercise geometry and bounded repair with a mocked model.

For a paid generation test:

```sh
npm run test:ai -- --generate-only
```

Use `AI_TEST_PROMPT` to change the subject. The default is a cabin with a chimney and pine tree. A successful generated workshop is preserved for visual review, and detailed results are written to ignored `artifacts/ai-generation.json`. `--generate` runs both the fixture checks and inference.

Generation quality and latency remain subject to measurement. Initial candidates that fail validation are never published. See `QUALIFICATION.md` for actual results and existing launch gates.

## Extensions

Editing an existing workshop would need a captured generation/revision snapshot, a preview of the proposed changes, and final collision and revision checks under the existing spatial locks. Repetition, mirroring and verified mechanical assemblies can reduce output size and spatial mistakes. Image references and moving mechanisms require separate qualification; the blueprint does not imply motors, free-angle rotation or simulation.
