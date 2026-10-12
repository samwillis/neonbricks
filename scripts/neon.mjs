import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const entry = new URL(
  "../.tools/neon-pkgs/packages/cli/dist/cli.js",
  import.meta.url,
);
if (!existsSync(entry))
  throw new Error("Build the pinned Neon toolchain first; see README.md.");
const child = spawn(
  process.execPath,
  [
    entry.pathname,
    ...process.argv.slice(2),
    "--profile",
    "staging",
    "--api-host",
    "https://console-stage.neon.build/api/v2",
    "--no-analytics",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NEON_API_HOST: "https://console-stage.neon.build/api/v2",
      NEON_OAUTH_HOST: "https://oauth2-stage.neon.build",
      NEON_PROFILE: "staging",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
