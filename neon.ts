import { defineConfig } from "@neon/config/v1";
const origins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
).split(",");
export default defineConfig({
  aiGateway: true,
  preview: { realtime: { allowedOrigins: origins } },
  triggers: {
    "workshop-cleanup": {
      type: "schedule",
      function: "bricks",
      cron: "*/5 * * * *",
      functionPath: "/api/cleanup",
    },
  },
  functions: {
    bricks: {
      name: "Neon Bricks API",
      source: "src/server/app.ts",
      env: {
        REALTIME_SECRET: process.env.REALTIME_SECRET!,
        REALTIME_URL: process.env.REALTIME_URL!,
        ALLOWED_ORIGINS: origins.join(","),
        AI_MODEL: process.env.AI_MODEL || "gpt-5-4",
        AI_DAILY_LIMIT: process.env.AI_DAILY_LIMIT || "40",
      },
    },
  },
});
