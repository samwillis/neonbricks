# Implementation and qualification

Recorded 12 October 2026. This is the built staging demo; public frontend release is still a separate deployment step.

## Foundation decisions

- The staging Sam workspace is used throughout. PG18 and logical replication are enabled. Ohio replaces the plan's provisional Frankfurt region because the supplied setup reference had qualified Realtime in Ohio.
- SDK and CLI source is pinned to `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4`. Portable tarballs are checked in; secrets and the CLI source checkout are ignored.
- The initial JSON-valued scene query failed with “scalar expression uses a mutable function.” The equivalent typed-column UNION query passed against staging, including correlated membership/session predicates. No additional scene projection table was needed.
- Static mechanical fit uses discrete yaw, voxel occupancy, stud/socket pairs, shaft/hole pairs, cardinal gear mesh slots, and a coplanar paired-hinge slot. Animation and mechanism control are deferred.
- The database takes neighbourhood and changed-part locks. Regular edits share the world lifecycle lock. Independent attachments do not exclusively lock a common baseplate.

## Checks completed

| Check                     | Result                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Geometry                  | Eight tests: 36 shapes × four poses, starter validation, shaft fits, incompatible connectors, fixed gear/hinge poses, bucket coverage, coordinate limits                                                                 |
| End-to-end races          | 100 trials each: empty-region collision, intersecting rotations across bucket boundaries, disjoint placements, move/delete, newly adjacent connectors, distinct shared-baseplate attachments                             |
| Receipts and compensation | Identical replay, digest mismatch, foreign receipt isolation, stable rejection, repeated undo/redo, third-party revision conflict, stale-generation replay, coherent reset                                               |
| Access                    | Viewer role denies edits; membership withdrawal empties scene/presence/history; session revocation empties live rows; session expiry rejects renewal and existing capability ceases to be live by its 60-second boundary |
| Presence                  | Sequence ordering, heartbeat preserves preview timestamp, clean leave, delayed update cannot recreate viewer, public cleanup request rejected                                                                            |
| Lifecycle                 | 100 close-versus-edit trials; owner reopen/reset; closed world rejects further edits                                                                                                                                     |
| Lock independence         | Holding one neighbourhood lock does not block a distant placement; an intersecting edit times out with 503 and succeeds using the same operation ID after release                                                        |
| Deployed mechanical fit   | 28 shaft/receiver combinations across four yaws create their connection; offset moves are rejected without changing topology                                                                                             |

The race suite uses independent guest sessions and simultaneous requests with varied dispatch order, through the deployed Function and real Postgres. It observes results through Realtime. These checks establish the tested cases; they are not a formal proof of every possible interleaving.

## Capacity measurement

The reference workload uses a synthetic 2,000-part scene with seven part shapes and twelve independent guests, each with scene, presence, and history subscriptions. Commands mix moves, recolours, deletions, and replacements. Presence heartbeats run every ten seconds; continuous placement-preview traffic is not included. The observer records command dispatch to an authoritative peer SDK snapshot with a monotonic clock. Browser render latency is a separate measurement. Runs begin after initial query admission and fixture loading; they do not isolate cold-wake latency.

The initial full reference run completed 2,880 commands without errors. Peer SDK visibility was 421.9 ms at p50 and 849.3 ms at p95, with a 2,061.6 ms maximum. HTTP receipt p95 was 585.3 ms. The raw result is preserved in `artifacts/capacity-original.json`.

Batching transaction setup and combining access checks reduced Function processing to approximately 31–32 ms at p50 and 50–51 ms at p95. A subsequent short `ws` transport run completed 1,585 commands without API or delivery errors, with peer visibility p50 289.9 ms and p95 629.5 ms, and HTTP receipt p95 420.2 ms. Its harness incorrectly flagged a one-command scheduling overshoot as a shortfall; phase scheduling and the shortfall check were corrected for the final run. This short comparison is preserved in `artifacts/capacity-optimized-ws-short.json`.

An intervening native Node 22 WebSocket comparison was slower and failed to sustain the burst rate. Node's close-handshake behaviour also left completed test processes alive; Node harnesses now use the SDK-supported `ws` transport. The tests and browser use the same SDK; browsers retain their native WebSocket.

The final full `ws` run **failed qualification**. It completed 2,605 of 2,880 requested commands: 1,165 during the burst and 1,440 during the ten-minute steady phase. Observed peer delivery was 551.7 ms at p50, 1,064.6 ms at p95, and 2,848.6 ms maximum. HTTP receipt p95 was 529.7 ms; Function processing p50/p95 was 35.4/62.3 ms. Diagnostics recorded nine `resource_exhausted` connection losses, one rejected upstream subscription, one other connection loss, and one heartbeat timeout. Eighteen renewal attempts failed, including failures after a connection became unrecoverable. The report contains those failures plus the workload shortfall, and the script exits unsuccessfully. The result is preserved in `artifacts/capacity.json` and `.tools/capacity-final.log`.

Successful command delivery to the measured observer does not establish that every participant remained subscribed. Query admission, renewal, and resource limits under sustained load need investigation with the Realtime service before repeating this workload or selecting a smaller public operating envelope. The normal two-browser editor checks passed; that is the demonstrated interactive case, without a promised latency budget.

**The proposed 500 ms p95 target has not passed.** These measurements qualify neither peer-painted-frame latency nor a public participant cap. Network distance from London to Ohio, HTTP receipt overhead, and Realtime variability remain relevant; low Function processing time alone does not explain all of that latency. Public capacity remains a release gate.

Rendering was checked on an Apple M4 Max with 48 GiB memory, in Codex's in-app Chromium browser at an actual 1280 × 720 CSS viewport. The standard quality setting used DPR up to 1.75, dynamic directional shadows, and a refreshed contact-shadow pass. With 2,000 parts, the inspector observed approximately 10–11 ms p95 frame intervals over a rolling 600-frame foreground window, including an orbit check. The scene reported roughly 1.69 million visible triangles and twelve draw calls before collaborator selection overlays. This measurement does not qualify lower-powered devices or the 5,000-part growth case.

## Browser verification

The browser calls the deployed Function directly. Independent guests joined an isolated room and exercised placement, selection, recolouring, duplicate, move, multi-selection, rotation, repeated undo/redo, and bulk deletion/restoration. A peer received the committed scene and coloured selection outlines. Owner reset restored 26 parts and 37 connections.

The production build on port 4173 created a fresh starter room. Its catalogue thumbnails, static mechanical pieces, inspector, and presentation view were inspected. The 390 × 844 CSS viewport had no horizontal page overflow and supported model viewing and camera presets; editing is intended for desktop. Temporary viewport overrides were reset. Final screenshots are saved under ignored `artifacts/`.

The subsequent movement UX check used an isolated room in the production build: clicking selected a piece and exposed X/Y/Z handles; direct dragging preserved height and did not orbit the camera; the Y handle changed height, and the X handle constrained movement. Shift-click and dragging a selected member moved a two-part group; undo restored it. An out-of-board drop showed feedback and left the transaction unchanged. Background dragging orbited without an edit. One-shot placement returned to selection, Keep placing allowed repeated additions, and clicking an existing brick in build mode added a stacked brick and its connection. A second guest received the added parts and selection outlines. Read-only inspection of Postgres receipts confirmed one operation per successful drop, preserved group offsets, and constrained coordinates.

Four movement regression tests cover planar and axis snapping, fine movement, preserved off-grid origins and group offsets, immutable pickup revision/connection preconditions, and collision/bounds checks. Eight pointer-lifecycle cases cover click jitter, Escape during a held drag, a single drop outside the canvas, pointer cancellation, lost capture, focus loss, lifecycle cancellation, and disposal. They verify that cancellation releases capture, restores the camera, and submits no edit. Together with the eight geometry tests, all twenty tests pass. Browser checks also verified Escape from the focused Keep placing checkbox and from the optional M pickup tool. These checks do not repeat or change the capacity qualification above.

Surface snapping was then restored to direct dragging and shared with placement, M pickup, and copying. Twelve additional tests cover logical stud height, off-grid targets, group offsets, occupied attachments, axle/beam fits across four yaws, moved receivers, gears, hinges, rotated side bounds, explicit build layers, instanced-mesh target normals, and axis constraints. The suite now has 32 passing tests. In a fresh isolated production-build room, an existing brick dragged onto another brick created its stud connection; a new brick snapped to a free stud; an axle placed through a beam hole and a dragged bearing each created their attachment. M pickup stacked a brick and copying added another connected piece. Surface snapping preserves the movement snapshot's revision and connection preconditions.

The Neon-inspired visual update adds locally bundled Inter, a smaller `neonbricks` wordmark with its outlined brick on the left, and coordinated light/dark colours for the interface, scene, and thumbnails. Appearance preferences persist on reload and synchronize across tabs; System and keyboard dismissal were also checked. The editor removes duplicate headings and selection actions, and replaces the build-layer panel with automatic snapping and the selected piece's Y handle. In an isolated room, placing a 1 × 1 brick against the upper side of a 2 × 2 brick saved a stacked piece and its stud connection. Four new tests cover upper-edge stud capture, lower-side placement, fine placement, and occupied attachments; all 36 tests pass. The production build passes, with the existing Three.js bundle-size warning.

The revised header, camera controls, toolbar, selection indicator, and help were checked at desktop size and at 390 × 844 and 780 × 844 CSS viewports. Narrow-screen help now wraps within the viewport; neither responsive check had horizontal page overflow. Editing remains intended for desktop. Viewport overrides were reset and the existing user build was preserved. Light/dark previews are saved as `artifacts/neonbricks-light.png` and `artifacts/neonbricks-dark.png`. These visual checks do not change the capacity qualification above.

The inspector's responsive position previously let its panel cover its toggle. The panel now anchors above that button, has its own close button, and closes with Escape. Browser checks exercised repeated toggle dismissal, close-button dismissal, and Escape, including 390 × 844 and 780 × 844 viewports. The mobile panel and toggle were separated by 12 pixels. The header's Display menu now contains theme, construction grid, and enhanced lighting controls; grid and lighting were switched off and back on, and Light/Dark rendering was checked. The wordmark is smaller again, and its brick symbol is reduced to three simple paths. Type checking and the production build pass. Viewport and display settings were restored; verification made no scene edits. The updated preview is `artifacts/neonbricks-display-controls.png`.

Transient renewal failures retry after one second, including when sealing succeeded before the subscription renewal failed. Scheduling uses the estimated server clock. Epoch/disposal guards prevent obsolete callbacks from acting on another room.

An active guest-session renewal was also checked through the deployed API: it extends the sliding expiry and clamps it to the absolute expiry. This is separate from the ten-minute capability-renewal workload.

## Remaining public-release work

- Choose the frontend host/domain, add its exact origins, and verify its SPA routing and HTTPS deployment.
- Resolve the latency/workload release gate and measure local preview latency and bulk-edit visibility separately.
- Include continuous preview traffic, cold wake-up, and client memory/subscription growth in final capacity and long-session qualification.
- Rehearse recovery from a prior compatible application release once this first runnable baseline has a successor.
- Add edge-level abuse control for anonymous session and room creation, and settle long-term storage pruning and ownership recovery. This staging demo does not claim those production policies are complete.
- Run the five-visitor first-minute usability study and the 5,000-part growth test.
- Measure command dispatch to a peer's actual painted frame if the launch makes a browser-render visibility claim. The capacity script measures authoritative SDK delivery.
- Qualify the intended public audience's hardware and network. Current rendering evidence comes from an M4 Max.

For the next phase, specify joint degrees of freedom, movement envelopes, and shared control before animating the hand crank. Motors should use database control state plus timestamped phase anchors, with client interpolation, as outlined in `PLAN.md`.
