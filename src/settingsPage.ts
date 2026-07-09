import type { Settings, Theme } from "./types";
import { ZOOM_LEVELS } from "./state";
import { icons } from "./icons";

export interface SettingsHooks {
  get(): Settings;
  onTheme(t: Theme): void;
  onHidden(v: boolean): void;
  onDefaultZoom(z: number): void;
  onLowercaseTabs(v: boolean): void;
  onSystemIcons(v: boolean): void;
}

export interface SettingsPage {
  el: HTMLElement;
  /** Re-read state into the controls (e.g. after Cmd+Shift+. elsewhere). */
  sync(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label: string, hint: string, control: HTMLElement): HTMLElement {
  const r = el("div", "setrow");
  const left = el("div", "setlabel");
  left.append(el("div", "setname", label), el("div", "sethint", hint));
  r.append(left, control);
  return r;
}

export function buildSettingsPage(hooks: SettingsHooks): SettingsPage {
  const root = el("div", "settings");
  const inner = el("div", "settings-inner");
  root.append(inner);
  inner.append(el("h1", "", "Settings"));

  // Sections are just (title, rows...) — adding future sections is one call.
  const section = (title: string, ...rows: HTMLElement[]) => {
    const s = el("section", "setsection");
    s.append(el("h2", "", title), ...rows);
    inner.append(s);
  };

  // Theme segmented control
  const seg = el("div", "seg");
  const themeBtns = new Map<Theme, HTMLButtonElement>();
  for (const t of ["light", "dark", "system"] as Theme[]) {
    const b = el("button", "", t[0].toUpperCase() + t.slice(1));
    b.addEventListener("click", () => {
      hooks.onTheme(t);
      sync();
    });
    themeBtns.set(t, b);
    seg.append(b);
  }

  // Toggle switch factory: reads its value and applies a change via callbacks.
  const makeSwitch = (read: () => boolean, write: (v: boolean) => void) => {
    const s = el("button", "switch");
    s.setAttribute("role", "switch");
    s.append(el("span", "knob"));
    s.addEventListener("click", () => {
      write(!read());
      sync();
    });
    return s;
  };
  const hiddenSw = makeSwitch(() => hooks.get().showHidden, hooks.onHidden);
  const lowerSw = makeSwitch(() => hooks.get().lowercaseTabs, hooks.onLowercaseTabs);
  const sysIconSw = makeSwitch(() => hooks.get().systemIcons, hooks.onSystemIcons);

  // Default zoom stepper
  const stepper = el("div", "stepper");
  const minus = el("button", "stepbtn");
  minus.innerHTML = "&minus;";
  const val = el("span", "stepval");
  const plus = el("button", "stepbtn");
  plus.innerHTML = icons.plus;
  const stepZoom = (d: 1 | -1) => {
    const cur = hooks.get().defaultZoom;
    const i = ZOOM_LEVELS.reduce(
      (best, z, j) => (Math.abs(z - cur) < Math.abs(ZOOM_LEVELS[best] - cur) ? j : best),
      0
    );
    const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + d))];
    hooks.onDefaultZoom(next);
    sync();
  };
  minus.addEventListener("click", () => stepZoom(-1));
  plus.addEventListener("click", () => stepZoom(1));
  stepper.append(minus, val, plus);

  section(
    "Appearance",
    row("Theme", "Light, dark, or follow macOS", seg),
    row("Show hidden files", "Dotfiles in both panes — ⌘⇧.", hiddenSw),
    row("Default zoom", "Startup zoom level — ⌘0 returns here", stepper)
  );

  section(
    "Tabs",
    row("Lowercase tab titles", "Show tab names in all lowercase", lowerSw)
  );

  section(
    "Files",
    row("System file icons", "Use macOS icons instead of Delight's vector set", sysIconSw)
  );

  const setSwitch = (s: HTMLElement, on: boolean) => {
    s.classList.toggle("on", on);
    s.setAttribute("aria-checked", String(on));
  };

  function sync(): void {
    const s = hooks.get();
    for (const [t, b] of themeBtns) b.classList.toggle("on", s.theme === t);
    setSwitch(hiddenSw, s.showHidden);
    setSwitch(lowerSw, s.lowercaseTabs);
    setSwitch(sysIconSw, s.systemIcons);
    val.textContent = `${s.defaultZoom}%`;
  }
  sync();

  return { el: root, sync };
}
