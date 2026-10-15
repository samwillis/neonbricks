# Neon Bricks

Build a brick model together in your browser. Neon Bricks is a collaborative 3D workshop with snapping bricks, mechanical parts, shared cursors, undo/redo, and an AI builder you can chat with. Share a workshop URL to build with someone else or follow the same model on another device.

It demonstrates [Neon Realtime](https://neon.com/docs/realtime/overview): live SQL subscriptions that keep clients in sync as data changes in Postgres. The model, collaborator presence, and AI conversation all live in Postgres, with updates delivered through Realtime.

**[Open the demo](https://neonbricks-app.vercel.app)** · **[Read the Neon Realtime docs](https://neon.com/docs/realtime/overview)**

## Built on Neon

Alongside Realtime, the demo uses:

- **Neon Postgres** to store workshop pieces, their connections, guest memberships, presence, edit history, and AI conversations. Transactions keep simultaneous edits consistent, including preventing two builders from placing pieces in the same space.
- **Neon Functions** for the backend API. Functions authenticate guests, authorize Realtime subscriptions, commit workshop edits, and run AI builds alongside the database.
- **Neon AI Gateway** to generate and refine models from text prompts. The Function calls the Gateway, writes progress and draft pieces to Postgres, and Realtime delivers them to everyone in the workshop.

The frontend uses React and Three.js and is hosted on Vercel. The API, database, Realtime, and AI run on Neon.

## Try it

Start with the rover or a blank canvas, then choose from 36 parts and 12 colours. Click to place a part, drag existing pieces to move them, and snap onto other bricks or compatible mechanical connectors. Wheels, axles, gears, and hinges fit together as static assemblies.

Share the workshop URL with another browser or device. You can see each other's cursors, selections, and placement previews while building. Each builder has their own undo/redo history.

Choose **Build with AI** to describe a new model, or open **AI** in an existing workshop to ask for changes. Watch the draft appear on the canvas, then choose **Apply to model** to add it as one undoable edit. The chat and draft are shared across the workshop, so collaborators can follow a build as it happens and continue the conversation.

| Action             | Control                                    |
| ------------------ | ------------------------------------------ |
| Orbit / pan / zoom | Drag the background / right-drag / scroll  |
| Select / move      | Click a piece / drag it or its X/Y/Z arrow |
| Select several     | Shift-click                                |
| Rotate             | R                                          |
| Duplicate          | Cmd-or-Ctrl D                              |
| Delete             | Delete or Backspace                        |
| Undo / redo        | Cmd-or-Ctrl Z / Shift Cmd-or-Ctrl Z        |
| Cancel placement   | Escape                                     |

The **Display** menu switches between light and dark themes and controls the grid and lighting. Presentation mode gives the model more space. Desktop browsers support the full editor; smaller screens can follow the model and shared AI chat.

## How it is built

### Live workshop state

The browser sends edit commands to a Neon Function over HTTP. The Function checks the edit and commits the pieces, connections, and history in a Postgres transaction. Neon Realtime then delivers the committed state to subscribed browsers.

A single scene query combines the workshop, pieces, and connections so the browser can apply each scene update together. Presence, personal undo history, member details, and workshop AI chat use separate live queries over the same WebSocket connection. Clients subscribe to database changes instead of polling for workshop updates.

Functions issue short-lived, sealed queries scoped to the guest's workshop membership. The browser renews these capabilities while connected; database and Realtime sealing credentials stay on the backend.

### Concurrent building

The scene uses a 32 × 32 stud board, with coordinates stored as integer sixths of a stud. Geometry and connector definitions are shared between the browser and backend, giving local placement previews and server-side checks the same rules.

Geometric edits lock the affected spatial buckets and piece rows. Collision checks, connections, revisions, and undo history commit together. Builders working in distant parts of a workshop can edit concurrently without taking a single exclusive lock for the whole scene. Stale or conflicting edits are rejected without partially changing the model.

Collaborator cursors and placement previews are stored in Postgres presence records and delivered through a Realtime subscription. Cursor positions use world coordinates, so they point at the same brick even when collaborators have different camera views. The frontend interpolates incoming positions for smooth movement.

### Shared AI building

An AI prompt creates a Postgres generation record and starts work in a Neon Function. The Function calls Neon AI Gateway for a structured design, expands repeated pieces and assemblies, and checks that the result fits together. Progress, streamed drawings, and the conversation are written to Postgres and arrive through the workshop's Realtime subscription.

Generation continues after the initial HTTP response. Applying a draft uses the same transactional editing system as manual building, with a check that the model has not changed since the AI captured it. Generated pieces remain ordinary editable bricks. See [AI_BUILDING.md](AI_BUILDING.md) for the design format and AI workflow.

### Source layout

| Path                       | Contents                                                                          |
| -------------------------- | --------------------------------------------------------------------------------- |
| [src/client/](src/client/) | React editor, Three.js scene, live subscriptions, and collaborative cursors       |
| [src/server/](src/server/) | Function API, guest sessions, transactional edits, live queries, and AI execution |
| [src/shared/](src/shared/) | Part catalogue, geometry, connectors, snapping, and AI design formats             |
| [drizzle/](drizzle/)       | Postgres migrations                                                               |
| [neon.ts](neon.ts)         | Neon Function, Realtime origins, AI Gateway, and scheduled jobs                   |

## Run locally

You need Node.js 22.18 or newer and a Neon project with Realtime enabled. To use the AI builder, enable Neon AI Gateway on the same branch. The Neon SDK packages used by the demo are pinned in `.sdk/` and installed by `npm ci`.

```sh
git clone https://github.com/samwillis/neonbricks.git
cd neonbricks
npm ci
cp .env.example .env.local
```

Fill in `.env.local` with your Neon branch's connection details and Realtime settings:

| Variable                 | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `DATABASE_URL`           | Postgres connection string for the API                                   |
| `DATABASE_URL_UNPOOLED`  | Direct Postgres connection string for migrations                         |
| `REALTIME_SECRET`        | Server-side secret for sealing Realtime queries                          |
| `REALTIME_URL`           | Realtime WebSocket URL for the Function's subscriptions                  |
| `VITE_NEON_REALTIME_URL` | The same Realtime WebSocket URL, used by the browser                     |
| `VITE_API_URL`           | Leave empty to use the local API through Vite's proxy                    |
| `ALLOWED_ORIGINS`        | Browser origins allowed by the API; the example includes local Vite URLs |

For local AI builds, also set `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN`. `AI_MODEL` optionally selects the Gateway model; it defaults to `gpt-5-4`. Only the public endpoint variables use the `VITE_` prefix; database, sealing, and Gateway credentials stay on the server.

Apply the migrations and start the app:

```sh
npm run db:migrate
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite serves the frontend and proxies API requests to the local Node server on port 3001. Postgres, Realtime, and AI Gateway run on your Neon branch. Allow the local frontend origin in that branch's Realtime configuration as well. Restart the app after changing environment variables.

To run just the frontend against a deployed Neon Function, set `VITE_API_URL` to its origin, without `/api`, and `VITE_NEON_REALTIME_URL` to its Realtime URL, then run `npm run dev:web`. Include your local frontend origin in both the Function's CORS configuration and Realtime's allowed origins.
