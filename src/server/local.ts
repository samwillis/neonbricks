import { serve } from "@hono/node-server";
import app from "./app";
serve({ fetch: app.fetch, port: 3001, hostname: "127.0.0.1" }, () =>
  console.log("Neon Bricks API: http://127.0.0.1:3001"),
);
