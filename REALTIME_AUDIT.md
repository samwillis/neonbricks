# Realtime implementation audit

Audited 13 October 2026, at commit `b86d024`. This audit reviews application code, the installed `@neon/realtime` SDK, and the supplied SDK/example source. It makes no application changes, deployment, paid inference calls or workshop edits.

The core architecture uses Realtime correctly: the scene, presence, undo/redo query and workshop AI conversation subscribe to Postgres query results. The remaining problems concern renewal, competing state writers and lifecycle handling. There are also two polling paths around AI job management that can be replaced once the corresponding server responsibilities are covered.

## Resolution — 13 October 2026

All six findings are addressed in release `realtime-lifecycle-2`, deployed to the existing Sam staging Function and static Vercel frontend.

| Finding              | Change                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability refresh   | Shared `openLiveQuery` lifecycle schedules the next fetch before socket acknowledgement, uses `serverNow()`, retries transient failures, stops terminal failures and detaches denied subscriptions.                                                                                                                                     |
| History ordering     | Only the live query writes undo/redo. Empty snapshots clear it; generation-tagged pointers reconcile when history and scene arrive in either order. Receipts continue to confirm transactions and geometry.                                                                                                                             |
| Auxiliary status     | Presence, history and member queries expose separate states. Chat exposes connection failure/recovery, disables actions while stale and offers reconnect after a terminal error. Disposal aborts in-flight refreshes and rejects late callbacks.                                                                                        |
| Live member metadata | A member query updates profile and role. Manual editing, undo/redo and AI actions require live editor permissions. Rename receipts cannot overwrite a newer live profile.                                                                                                                                                               |
| AI lifecycle polling | The creation Function owns dispatch with `waitUntil`; a one-minute authenticated schedule reconciles queued/expired work. A trusted server Realtime subscription observes committed cancellation and closes in `finally`. Both recurring AI polling paths are removed.                                                                  |
| Payloads and indexes | Historical exchanges return scalar title/summary and piece count; only the active drawing/current ready draft includes geometry. Immutable scalar projections are accepted by Realtime. Stable row objects and memoized messages preserve historic renders. Target/order and partial legacy/order indexes support both lookup branches. |

Verification: 130 local tests pass, including long pending acknowledgement, rejected renewal, late refresh after disposal, authorization denial, terminal SDK errors, delayed receipts/profile responses, empty history and generation ordering and obsolete startup isolation. TypeScript and the production static build pass. Staging access, presence, synthetic AI lifecycle and shared-chat/application suites pass. `npm run test:realtime` confirms actual profile/role updates, access withdrawal, drawings, empty history, cross-process cancellation and expiry without inference. A separate five-piece Gateway build completed through the deployed Function without a browser panel, `/run` request or lifecycle reads.

For a representative history of 20 saved models and one active drawing, the initial JSON payload measured 222,269 bytes for full model history and 11,450 bytes for the narrowed result (94.8% smaller). The actual Postgres plan used both new indexes; measured planning/execution was 0.75/0.477 ms on that fixture. These are fixture measurements, not production capacity claims. Hosted browser checks confirmed chat loading, draft application, undo and redo. The plan and temporary screenshots are under ignored `artifacts/realtime-fixes/`.

Long transport outage tests use simulated SDK callbacks; no live outage was induced. Interrupted inference can remain busy for up to a further minute after its lease expires. Scheduled reconciliation and transactional claiming do not provide exactly-once inference after a worker disappears mid-call. These bounds are documented in `AI_BUILDING.md`.

The original findings below are retained as an audit record of commit `b86d024`.

## Findings

### 1. P1 — Capability refresh waits for the socket acknowledgement

References: `src/client/store.ts:190–198` and `src/client/store.ts:291–311`.

Both the workshop subscriptions and AI conversation obtain a replacement capability, await `sub.renew(...)`, and only then schedule the next capability refresh. The SDK's renewal promise resolves when the proxy accepts the replacement. It can remain pending during a WebSocket outage even when HTTP is available.

Consequently, a pending renewal stops all further capability issuance for that subscription. On a long outage the replacement itself expires, and recovery first encounters an obsolete capability. This does not prove every outage permanently breaks the app: the SDK can reject expired capabilities and a subsequent retry may recover. It does create an unnecessary gap in authorization refresh and prolongs recovery.

Local reproduction: return an unresolved renewal promise while allowing all HTTP requests. After the initial capabilities and their 48-second replacements, neither scene nor conversation fetches another capability over the following 120 seconds.

Fix: share a renewal controller that schedules the next capability fetch immediately after receiving a valid replacement, independently of its wire acknowledgement. Handle renewal failure separately, guard obsolete callbacks, and keep refreshing through an outage. The installed SDK already exports `QueryRefreshController` with this behavior, and its upstream tests cover pending acknowledgement. Preserve the app's `serverNow()` clock correction when adopting or adapting that controller; the SDK's default scheduler uses `Date.now()`.

### 2. P1 — HTTP responses can overwrite newer Realtime history

References: `src/client/store.ts:217–221`, `src/client/store.ts:332–333`, `src/client/store.ts:372–379`, `src/client/store.ts:599` and `src/client/store.ts:656`.

History has three competing writers: its live query, direct HTTP history reads, and edit receipts. None of the latter two carries an ordering revision that the store checks before publishing.

A delayed HTTP history response or earlier mutation receipt can replace a newer live undo/redo pointer. This can happen during startup, reset or overlapping commands, including another tab using the same guest identity. It can offer the wrong operation for undo. Postgres still validates commands, so this finding is about stale client state, rather than unvalidated database writes.

The history listener also ignores an empty authoritative result. If its row disappears, or access predicates remove it, the previous undo/redo pointer remains cached.

Local reproductions confirm both late-response regressions and the empty-result behavior.

Fix: make the history live query authoritative. Remove unversioned HTTP overwrites, including `receipt.history`, and clear pointers when a live snapshot is empty. If immediate receipt-based display is important, add a monotonic history revision to both sources and reconcile explicitly. Keep edit receipts for confirmation, conflict details and optimistic scene reconciliation.

### 3. P2 — Auxiliary subscription state and authorization cleanup are incomplete

References: `src/client/store.ts:182–205`, `src/client/store.ts:369–376`, `src/client/AIBuildPanel.tsx:57–74` and `src/client/App.tsx:1248–1267`.

Presence and history callbacks discard their subscription status/error arguments. The conversation wrapper forwards live rows and errors, but does not expose `connecting`, `stale` or `closed`. The footer reports only scene status. A query-specific failure can therefore leave the scene marked **Live & saved** while cursors/history/chat have stopped updating. The SDK explicitly supports per-subscription failures and recovery, so a healthy scene does not imply every query is healthy.

The panel can retain an obsolete busy/ready state during a conversation-specific outage, and an initial failure can leave it displaying “Opening the conversation…” with no retry. Errors are also not cleared on a subsequent healthy conversation snapshot.

On a denied conversation capability renewal, the wrapper clears displayed rows but leaves the listener and subscription active. A later live callback can repopulate them. Membership withdrawal and explicit revocation usually make the query empty because those database predicates change. Natural session expiry is a distinct case: the SQL checks `revoked`, while expiry is enforced when issuing capabilities and later by cleanup. Do not allow callbacks after an authorization denial to restore cleared state.

Local reproductions confirm the ignored presence failure, invisible conversation staleness and the active listener after renewal denial. These are simulated lifecycle callbacks, not a live authorization-exploitation test.

Fix: track each query's status separately. Show a stale/read-only chat state, disable actions dependent on its current draft, and clear transient errors on recovery. Unsubscribe and detach listeners after terminal authorization denial. Clear authoritative empty results. A global outage can have one overall indicator; individual query failures should identify the affected feature without falsely declaring the entire scene unsaved.

### 4. P2 — Current-member metadata is not kept live

References: `src/server/worlds.ts:139–147`, `src/server/live.ts:15–45`, `src/client/store.ts:263–270`, `src/client/store.ts:369–370` and `src/client/App.tsx:258–259`.

The current guest's name, colour and `canBuildAI` permission are captured on join. Name/colour updates arrive in presence rows, but the store does not reconcile them into the current guest's profile state. A second tab can change that guest's name while the first tab's avatar/editor still uses its old profile.

Membership role changes are also absent from the live result. The access predicate checks active membership but does not return its role. An editor-to-viewer change leaves the old AI permission displayed until a rejoin. Ordinary editing's `canEdit` condition checks live scene/open workshop/draft state, without checking membership role at all. The server still enforces roles; the UI can offer actions that it will reject.

The profile inconsistency is locally reproduced. Role synchronization is established from the join/query/control code; no live memberships were changed.

Fix: include current-member metadata in a live query, either a small dedicated query or a typed row in the scene result. Synchronize profile and role from it, and use that role consistently for manual editing and AI controls. Keep the existing server authorization and membership/session predicates.

### 5. P2 improvement — AI job management still polls

References: `src/client/AIBuildPanel.tsx:106–120`, `src/server/ai.ts:83–90`, `src/server/ai.ts:567–574`, `src/server/ai.ts:635–645` and `neon.ts:12–18`.

There are two genuine polling paths:

- Every open, busy AI panel GETs its generation every five seconds. Those response bodies are discarded. The read calls `expireGenerations()`, so the poll's current purpose is detecting expired work and causing a Postgres status update. Several viewers duplicate that housekeeping work.
- Each running Function SELECTs the generation status every two seconds to discover cancellation in another isolate. The local controller map only handles cancellation within the same isolate. A transient error from that SELECT also aborts inference.

AI prompts, drawings, progress and final results already render from the workshop conversation live query. This is not HTTP polling masquerading as Realtime rendering.

Fix cancellation by subscribing from the trusted Function to a narrow generation-status query and closing that subscription in `finally`. The installed server SDK supports direct subscriptions with managed capability renewal. Retain the deadline and status checks guarding writes; transport staleness should not itself mean “cancelled”. Qualify that subscription lifecycle on Neon Functions before removing the fallback.

Fix expiry with server-owned scheduled reconciliation or durable job execution. The existing cleanup trigger runs every five minutes, so simply deleting the client poll changes how long interrupted work remains “busy”. Realtime does not create a database mutation just because a deadline passes. A server must write the expired status; then Realtime delivers it. A one-shot, lease-based reconciliation request is a transitional alternative to polling every five seconds.

Queued work is also started by an editor's mounted panel after it sees the queued row. Transactional claiming correctly prevents duplicate inference across editors, but execution remains coupled to an open browser panel. Moving dispatch/expiry to a server job mechanism would let the frontend observe work entirely through Realtime. Realtime alone is not a durable job queue.

### 6. P2 improvement — AI live-query payloads and indexing can be narrowed

References: `src/server/ai.ts:58–61`, `src/server/ai.ts:117–120`, `src/server/schema.ts:60–63` and `src/client/ai-conversation.ts:9–25`.

The latest 50 conversation rows include each full canonical `blueprint` and expanded `preview`. The panel mainly needs prompt/status/summary metadata for old exchanges, and geometry for the current draft. Baseline/reset delivery includes all these historical models, and hot preview updates replace the changed row's complete JSON projection. This does not imply every update retransmits all 50 models: the SDK receives changes and materializes the full result locally.

On every conversation snapshot, `conversationRows()` also sorts/maps all exchanges into new objects, causing history to render again during preview streaming.

The declared migrations/indexes cover `(guest, created_at)` and `(status, lease_until)`, but not the shared conversation's `(target, created_at, id)` lookup. Its legacy untargeted-world branch needs separate consideration. No live query plan or latency benchmark was run, so this is a scaling risk, not a measured slowdown.

Fix: narrow the conversation projection to the historical fields the UI uses; subscribe separately to active/latest-draft geometry if necessary. Preserve draft/source semantics and member access in both queries. Add suitable target/order indexes after checking representative query plans, including the legacy branch. Preserve stable row objects or memoize historical exchanges while previews stream.

## Polling and timer inventory

| Location                       | Activity                                                      | Assessment                                                                        |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AIBuildPanel.tsx:116`         | Generation GET every 5 seconds while busy                     | Genuine polling; lifecycle housekeeping, redundant across viewers; finding 5      |
| `server/ai.ts:567`             | Generation-status SELECT every 2 seconds                      | Genuine polling; cross-isolate cancellation; finding 5                            |
| `store.ts:291`, `store.ts:190` | Seal/renew query capabilities before expiry                   | Necessary authorization renewal, not polling application state; fix its scheduler |
| `store.ts:152`                 | Legacy generation-capability renewal every 40 seconds         | Authorization renewal; helper currently has no callers                            |
| `store.ts:380`                 | Presence POST every 10 seconds                                | Necessary liveness write, not polling                                             |
| `App.tsx:189`                  | Local tick and stationary cursor/preview refresh every second | TTL rendering and liveness write, not polling for remote changes                  |
| `store.ts:383`                 | Session renewal POST every 5 minutes when visible             | Necessary credential/session lifetime management, not polling                     |
| `AIBuildPanel.tsx:97`          | Local elapsed-time update every second                        | Local display only                                                                |
| `store.ts:625`                 | Up to six retries after uncertain mutation outcome            | Bounded idempotent command recovery; keep it                                      |
| `store.ts:217`                 | HTTP history reads at startup/reset/rejection                 | Not periodic polling, but competing unversioned state writer; finding 2           |
| `scripts/test-*.ts`            | Renewal/wait/workload timers                                  | Test harnesses, not frontend polling                                              |

Presence currently arrives through the database-backed live query, including cursor, selection and placement preview. Cursor animation interpolates locally between committed samples. Its sender coalesces to at most five samples per second. This matches the demo's Postgres-state architecture; replacing it with a separate broadcast service is not required by this audit.

## Correct patterns to preserve

- One Realtime client multiplexes workshop subscriptions on a shared socket.
- Scene header, pieces and connections share one `UNION ALL` query, so a transaction's scene changes are consumed together rather than reconstructed from independent table subscriptions.
- Commands write through authenticated Functions and Postgres transactions. Live query subscriptions are read paths; do not use them as an authorization substitute for writes.
- Manual edit confirmation uses committed transaction IDs with `awaitTxId`, with revision-based reconciliation when delivery is delayed. The SDK retains transaction/snapshot progress for responses arriving after live delivery.
- AI conversation rendering uses the live result as its authority. HTTP run/accept/cancel responses do not overwrite conversation snapshots.
- Membership and revocation predicates are inside the sealed SQL, so committed access changes affect existing results. Sealing endpoints also check current authorization; the browser receives no Realtime secret.
- Presence expiry is filtered using a local server-clock estimate. Moving a time predicate into SQL alone would not make it react merely to time passing.
- Renewals and presence sending already have useful disposal, epoch, ordering and coalescing protections. Keep those while unifying their lifecycle handling.

## Verification and suggested order

Eight local probes reproduce the existing behavior using mocked HTTP, subscription callbacks and fake timers. Passing here means the described defect was observed; it does not mean the defect is fixed. Evidence is saved in `artifacts/realtime-audit/results.txt`; the temporary probe source is archived as `artifacts/realtime-audit/probes.test.ts.txt`. The probes are removed from the regular test suite rather than preserving assertions that expect broken behavior.

These checks did not induce a live transport outage, mutate memberships or run paid inference. They do not qualify capacity, mobile networks or recovery latency.

Suggested implementation order:

1. Unify capability renewal without waiting for wire acceptance. Add regression coverage for long socket outages with working HTTP, expiry, denied renewal and unmount during renewal.
2. Make history authoritative through Realtime; cover delayed reads/receipts, empty results, reset and overlapping operations.
3. Expose per-query status, detach denied subscriptions and synchronize current-member metadata. Cover role changes, shared-identity profile changes and stale chat controls.
4. Replace AI cancellation polling with a qualified trusted subscription, and move expiry/dispatch responsibility to the server before removing browser housekeeping.
5. Narrow AI history payloads, add indexes supported by query plans, and measure render/query cost under the intended workshop workload.

The unused `watchGeneration` wrapper and its older progress-ordering helper can then be removed or brought under the same lifecycle implementation. They are not active frontend synchronization paths today.
