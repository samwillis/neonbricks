import { cp, mkdir, rm, writeFile } from "node:fs/promises";

// Vercel's Build Output API accepts this static bundle without uploading source
// files or the private Neon environment. API requests go directly to Neon.
const output = new URL("../.vercel/output/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("../dist/", import.meta.url), new URL("static/", output), {
  recursive: true,
});
await writeFile(
  new URL("config.json", output),
  JSON.stringify({
    version: 3,
    routes: [{ handle: "filesystem" }, { src: "/.*", dest: "/index.html" }],
  }),
);
console.log(
  "Prepared static frontend in .vercel/output (no Vercel Functions).",
);
