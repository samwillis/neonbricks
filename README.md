# Neon Bricks

A collaborative Three.js construction workshop. Postgres stores the model, connections, guests, presence, history, and command receipts. Neon Functions validate edits, and Neon Realtime publishes the committed scene.

The demo includes 36 procedural parts, 12 colours, a starter rover and workbench, placement and connector snapping, multi-selection, move/copy/rotate/recolour/delete, personal undo/redo, collaborator cursors, previews and selection outlines, camera presets, presentation mode, light and dark themes, and a demo inspector.

Mechanical assemblies are static. Axles and pins fit authored holes; gears have fixed cardinal mesh poses; hinge leaves pair in a coplanar pose. Free-angle joints, physical simulation, and motors belong to the subsequent phases in [PLAN.md](PLAN.md).

The workshop menu also includes **Build with AI**: prompt a model through Neon AI Gateway, preview a validated build, refine it with follow-up instructions and create a new collaborative workshop. Compact repetitions and verified assemblies expand to ordinary editable pieces. Progress and drafts live in Postgres and arrive through Realtime. See [AI_BUILDING.md](AI_BUILDING.md) for the format, limits and setup.

## Run the existing staging demo

Requirements: Node 22.18 or newer. The unpublished SDK packages are included as pinned tarballs in `.sdk/`, so the app does not need the CLI to run.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The ignored `.env.local` currently points the browser directly at the deployed Neon Function. The local API on port 3001 is also available; empty `VITE_API_URL` selects Vite's local proxy.

Existing resources are in **Sam**, in **staging**:

| Resource          | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Console           | <https://console-stage.neon.build/>                                                       |
| Workspace         | `org-wandering-poetry-25631650`                                                           |
| Project           | `quiet-dew-89918880` — neon-bricks                                                        |
| Branch            | `br-withered-sky-w2mvp9ef` — main                                                         |
| Region / Postgres | `aws-us-east-2` / 18                                                                      |
| Function          | <https://br-withered-sky-w2mvp9ef-bricks.compute.c-1.us-east-2.aws.neon.build/api/health> |

Keep `.env.local`, `.neon`, and `.tools/` private. The browser needs only `VITE_API_URL` and `VITE_NEON_REALTIME_URL`; database credentials and the sealing secret stay on the backend.

## Controls and demonstration

Pick a part and click the board to place it, then return to selection. Enable **Keep placing** to add several of the same piece. While placing, click an existing brick to stack or attach the new piece. Green previews fit; red previews conflict. Hover another part for a compatible connector pose. Hover the upper edge of a brick to catch its studs, or hold Alt for sixth-stud positioning. Use the Y arrow after selection for explicit height.

Click an existing piece to select it and reveal the X/Y/Z arrows. Drag onto another part to snap to its top, side, or compatible connector, preserving your grab point. Away from other parts, dragging keeps the original height. Placement, M pickup, and copying use the same surface and connector snapping. New mechanical pieces can orient automatically to a fitting connector; moving a selection preserves its rotations and relative positions. Drag an arrow to constrain movement; Y raises or lowers the selection in plate increments. Shift-click adds or removes pieces; dragging an already selected piece moves the group together. Release submits one edit for the whole selection. Escape cancels; an invalid drop leaves the originals in place. Revisions and incident connections captured at pickup let Postgres reject a conflicting concurrent edit.

| Action             | Control                                                         |
| ------------------ | --------------------------------------------------------------- |
| Camera             | Drag the background to orbit, right-drag to pan, scroll to zoom |
| Move directly      | Drag a piece, or drag its X/Y/Z arrow                           |
| Rotate             | R                                                               |
| Select several     | Shift-click                                                     |
| Pickup / duplicate | M, then click to place / Cmd-or-Ctrl D                          |
| Delete             | Delete or Backspace                                             |
| Undo / redo        | Cmd-or-Ctrl Z / Shift Cmd-or-Ctrl Z                             |
| Cancel             | Escape                                                          |

The room menu creates a rover room or blank canvas. Share that room's URL with a second browser/profile. Rename builders from their avatar. The creator can restore the starter, clear, close, and reopen their own room. Use presentation mode to hide the drawer and editing tools; the inspector shows transaction IDs, pending work, connection counts, and frame timing.

Each collaborator has a coloured pointer and name on the brick or board under their mouse. Cursor positions are shared in world coordinates, so they stay attached to the same surface when people use different cameras. They clear when the mouse leaves the canvas, the browser loses focus, or the tab is hidden. Presentation mode hides them along with the editing tools.

The **Display** menu in the header selects Light, Dark, or System, and toggles the construction grid and enhanced lighting. Turning enhanced lighting off reduces shadow detail and render resolution for better performance. System follows your operating system; an explicit theme choice persists in this browser and synchronizes across open tabs. The panels, thumbnails, board, lighting, and selection indicators all follow the theme. The demo inspector has a canvas toggle and a close button; Escape also closes it. The interface takes its typography and palette from neon.com. Its custom `neonbricks` wordmark matches the Databricks lettering, with a stylised line-drawn brick symbol on the left. Inter and the logo are bundled locally; provenance and the font licence are recorded under `public/brand/` and `public/fonts/`.

For a presentation, create your own rover workshop and keep its URL. Reset that room between demonstrations. The default shared workshop is independent of visitor-created rooms and cannot be reset by a visitor.

## Provisioning and deployment

The pinned toolchain is `neondatabase/neon-pkgs` commit `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4`, from `kevin-dp/realtime-env-pull`. Build the CLI in an ignored checkout:

```sh
git clone https://github.com/neondatabase/neon-pkgs.git .tools/neon-pkgs
git -C .tools/neon-pkgs checkout 5e276fdb4114555eac89f6033b15e6ff5e9e7eb4
cd .tools/neon-pkgs
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter 'neon...' build
cd ../..
```

The repository pins pnpm 10.30.3; `mise exec -- pnpm` is another option. To reproduce the SDK tarballs, build the relevant packages and use **pnpm pack**, which rewrites workspace dependencies. `.sdk/README.md` records provenance.

The wrapper in `scripts/neon.mjs` selects the staging API, OAuth host, and credentials profile on every call. Sign in with the existing Neon CLI if necessary:

```sh
NEON_API_HOST=https://console-stage.neon.build/api/v2 \
NEON_OAUTH_HOST=https://oauth2-stage.neon.build \
neon login --profile staging
```

For another environment, copy `.env.example` to a private env file, link a project in **Sam**, and enable PG18, logical replication, and Realtime. Obtain the socket URL and server secret from the staging Realtime API. Do not create a production project for this preview.

```sh
npm run db:migrate
npm run neon -- config plan --env .env.local
npm run neon -- deploy --env .env.local --no-env-pull
npm run build
```

Migrations use the direct connection and verify TLS certificates. The app reuses a module-level `pg` pool. `neon.ts` declares the Function, its secrets, permitted origins, and a five-minute authenticated cleanup trigger. Review the plan before applying changes to another branch.

For frontend hosting, publish `dist/` with SPA fallback to `index.html`, build with the two public `VITE_*` variables, and add the chosen HTTPS origin to both Function CORS and Realtime's allowed origins. The frontend has not yet been published to an external host.

After a release, keep its Git commit, pinned SDK tarballs, private environment file, and migration journal. To recover an earlier compatible application version, check out its commit in a separate checkout, install its lockfile, build the frontend, review the staging config plan, and redeploy its Function and frontend together. Preserve the database and receipts. Schema and catalogue changes need a forward-compatible migration before rolling application code back; the current schema has no destructive down-migration. The initial demo establishes the first runnable recovery baseline, so a previous-release rollback rehearsal remains a public-release check.

## Model and concurrency

Coordinates are integer sixths of a stud. One plate is two units high; the board spans 32 × 32 studs, with 16 studs of available height. The catalogue permits four yaw rotations. Authored occupancy masks keep shaft channels empty and validate parts independently of rendered meshes.

Geometric edits lock pre-created four-stud neighbourhood buckets in numeric order, then lock the changed part rows. A fresh READ COMMITTED candidate query runs after any bucket wait. Collision checks, connector discovery, capacity claims, revisions, tombstones, history, and receipts commit together. Distant builders use different buckets. The world row is held with a compatible shared lock during edits; reset and close take its exclusive lifecycle lock.

Appearance edits lock the changed parts and do not rebuild topology. Geometric edits compare the complete incident connection set, including an expected empty set. Undo/redo use compensating commands and effective revision bridges; another builder's changed revision or attachment can reject compensation.

One deterministic `UNION ALL` query carries the header, parts, and connections. It returns typed columns because the preview engine rejects the mutable JSON construction function. The browser assembles objects and applies each authoritative result atomically. Presence and personal history have separate subscriptions over the same socket.

Guest tokens are opaque and hashed in Postgres. Sessions slide for 30 minutes and have a 24-hour absolute maximum. Every sealed query contains membership and session-revocation predicates; capabilities expire after 60 seconds and renew before expiry. Session expiry denies renewal, so an existing capability can retain access only until its recorded expiry. There is no dependence on RLS in the preview engine.

Viewers heartbeat every ten seconds, expire visually after thirty seconds, and leave immediately on a clean close. Preview and cursor samples are coalesced at up to five requests per second, with one request in flight per viewer. The next sample can leave as soon as that request finishes and the 200 ms minimum between sends has elapsed. A stationary preview or cursor refreshes once per second while the tab is visible; both expire visually after three seconds without samples. A heartbeat does not refresh their timestamps. Cursor positions are fractional sixth-stud coordinates, stored separately from placement previews in `viewer_sessions`; the existing Realtime presence query delivers them. Each cursor follows incoming points with a critically damped spring, adapting to the observed update cadence and preserving velocity across packets. Deleted viewers are never implicitly recreated by a delayed packet; a returning browser rejoins with a new viewer ID.

New rooms accept edits for 24 hours, after which the cleanup job closes them. Closed rooms retain their model and receipts in this staging build; automatic permanent pruning is not enabled. The default workshop is exempt from expiry. There is no ownership recovery after losing a guest session, so create a new presenter room when that happens.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm run test:db
npm run test:access
npm run test:presence
npm run test:locks
npm run test:ai
npm run test:capacity
```

Database checks create disposable, isolated rooms in the linked staging project. `RACE_TRIALS=1 npm run test:db` runs a smoke test. Capacity qualification defaults to 2,000 parts, twelve builders, a 60-second burst at two commands per second per builder, and ten minutes at one command every five seconds. It writes results under ignored `artifacts/`.

See [QUALIFICATION.md](QUALIFICATION.md) for measured results, browser checks, and remaining release work. The preview is intended for desktop editing; narrow screens support viewing and camera inspection.
