import type { Theme } from "./types";

const mq = window.matchMedia("(prefers-color-scheme: dark)");
let current: Theme = "system";
const listeners = new Set<() => void>();

function effective(): "light" | "dark" {
  return current === "system" ? (mq.matches ? "dark" : "light") : current;
}

/** The theme actually being displayed right now ("system" resolved). */
export function effectiveTheme(): "light" | "dark" {
  return effective();
}

export function applyTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = effective();
  for (const fn of listeners) fn();
}

/** Notified whenever the effective theme changes (incl. live OS switches). */
export function onThemeChange(fn: () => void): void {
  listeners.add(fn);
}

// Live-follow macOS appearance while in System mode.
mq.addEventListener("change", () => {
  if (current === "system") applyTheme("system");
});
