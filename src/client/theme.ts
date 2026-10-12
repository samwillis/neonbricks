import { useEffect, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
const storageKey = "neon-bricks-theme";

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "system";
}

export function useTheme() {
  const [preference, setPreference] = useState(readPreference);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme: Theme =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null)
        setPreference(readPreference());
    };
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0b0c0e" : "#ffffff");
    try {
      localStorage.setItem(storageKey, preference);
    } catch {}
  }, [theme, preference]);

  return { theme, preference, setPreference };
}
