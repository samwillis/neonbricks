# Neon Bricks identity

`neonbricks.svg` is a custom lowercase wordmark and abstract outlined brick. The symbol sits to the left of the smaller name. Its rectangular top has a 2:1 footprint in isometric projection, with two raised pips along its length. An open outline keeps the body simple; each pip uses a flattened cap and a short lower edge to suggest height. Its stacked edges reference Databricks; its open seams and green stroke reference Neon. The same symbol is used in the favicon.

The Databricks wordmark is custom lettering rather than a distributed font. The `bricks` glyphs use the geometry published in Neon's Databricks wordmark SVG, and the `neon` glyphs are drawn to match its stem widths, x-height, counters, and spacing. Reference: [neon.com](https://neon.com/), `/_next/static/immutable/media/databricks-logo-dark.147gukn5u85gi.svg`, inspected on 12 October 2026. This is the demo's own logo.

The SVG exposes `wordmark` and `brick` groups so the app can colour them independently in light and dark mode. The complete SVG is also a standalone asset.

The interface uses Inter, bundled from `@fontsource-variable/inter` 5.3.0 (npm tarball SHA-1 `351dd1e02dab63a6cf66d57ec36dcfd10c07f07b`). Only the normal Latin variable font is included; its SIL Open Font License is preserved in `../fonts/INTER-LICENSE.txt`.
