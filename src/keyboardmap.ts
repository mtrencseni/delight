// A visual keyboard that answers "what does this key do?" for the bindings that
// are actually configured right now (state.keybindings, not the defaults).
//
// Opened with ⌘K / Ctrl+K or the keyboard button in the tab bar. It starts on
// the unmodified layer; hold a real modifier — or click one on the drawn
// keyboard — and the map switches to that layer (⌘, ⇧, ⌥, ⌃ and combinations),
// with the held modifiers lit up. While it's open every key is inert: the
// overlay swallows keydowns in the capture phase so nothing fires underneath.
//
// The drawn keyboard follows the host OS: a Mac gets fn/control/option/command,
// "delete"/"return" and no Insert; a PC gets Ctrl/Win/Alt + menu, backspace/
// enter and the full nav block.

import { COMMANDS, comboLabel } from "./commands";
import { state } from "./state";
import { isMac } from "./platform";

/** One drawn key. `w` is a width in key units (1 = a letter key); `mod` marks a
    modifier key, whose value is the canonical combo token it contributes. */
interface KeyDef {
  code: string;
  label: string;
  w?: number;
  mod?: string;
}

/** Short glyph for the layer title / hint line. */
const MOD_LABEL: Record<string, string> = isMac
  ? { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
  : { Meta: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };

/** The legend printed on the physical key — Apple spells its modifiers out. */
const MOD_KEY: Record<string, string> = isMac
  ? { Meta: "⌘ command", Ctrl: "⌃ control", Alt: "⌥ option", Shift: "⇧ shift" }
  : { Meta: "⊞ Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "⇧ Shift" };

/** Canonical modifier order — must match comboFromEvent in commands.ts. */
const MOD_ORDER = ["Meta", "Ctrl", "Alt", "Shift"];

function letters(s: string): KeyDef[] {
  return [...s].map((ch) => ({ code: `Key${ch}`, label: ch }));
}

const mod = (code: string, m: string, w: number): KeyDef => ({
  code,
  label: MOD_KEY[m],
  w,
  mod: m,
});

const GAP: KeyDef = { code: "", label: "" };

const MAIN_ROWS: KeyDef[][] = [
  [
    { code: "Escape", label: "esc", w: 1.4 },
    ...Array.from({ length: 12 }, (_, i) => ({ code: `F${i + 1}`, label: `F${i + 1}` })),
  ],
  [
    { code: "Backquote", label: "`" },
    ...Array.from({ length: 9 }, (_, i) => ({ code: `Digit${i + 1}`, label: `${i + 1}` })),
    { code: "Digit0", label: "0" },
    { code: "Minus", label: "−" },
    { code: "Equal", label: "=" },
    { code: "Backspace", label: isMac ? "delete" : "⌫ backspace", w: 2 },
  ],
  [
    { code: "Tab", label: "⇥ tab", w: 1.5 },
    ...letters("QWERTYUIOP"),
    { code: "BracketLeft", label: "[" },
    { code: "BracketRight", label: "]" },
    { code: "Backslash", label: "\\", w: 1.5 },
  ],
  [
    { code: "CapsLock", label: "caps lock", w: 1.75 },
    ...letters("ASDFGHJKL"),
    { code: "Semicolon", label: ";" },
    { code: "Quote", label: "'" },
    { code: "Enter", label: isMac ? "return" : "↩ enter", w: 2.25 },
  ],
  [
    mod("ShiftLeft", "Shift", 2.25),
    ...letters("ZXCVBNM"),
    { code: "Comma", label: "," },
    { code: "Period", label: "." },
    { code: "Slash", label: "/" },
    mod("ShiftRight", "Shift", 2.75),
  ],
  // Bottom row is where the two platforms differ most: Apple puts fn outside
  // control and has no menu key; a PC keyboard runs Ctrl-Win-Alt … Alt-Win-menu-Ctrl.
  isMac
    ? [
        { code: "Fn", label: "fn" },
        mod("ControlLeft", "Ctrl", 1.25),
        mod("AltLeft", "Alt", 1.25),
        mod("MetaLeft", "Meta", 1.5),
        { code: "Space", label: "space", w: 7.25 },
        mod("MetaRight", "Meta", 1.5),
        mod("AltRight", "Alt", 1.25),
      ]
    : [
        mod("ControlLeft", "Ctrl", 1.25),
        mod("MetaLeft", "Meta", 1.25),
        mod("AltLeft", "Alt", 1.25),
        { code: "Space", label: "space", w: 6.25 },
        mod("AltRight", "Alt", 1.25),
        mod("MetaRight", "Meta", 1.25),
        { code: "ContextMenu", label: "menu", w: 1.25 },
        mod("ControlRight", "Ctrl", 1.25),
      ],
];

// The nav/arrow cluster drawn to the right of the main block. Macs have no
// Insert key at all — anything bound to it lands in the overflow list instead,
// which is exactly the signal a Mac user needs.
const NAV_ROWS: KeyDef[][] = [
  [
    isMac ? GAP : { code: "Insert", label: "insert" },
    { code: "Home", label: "home" },
    { code: "PageUp", label: "pg up" },
  ],
  [
    { code: "Delete", label: isMac ? "⌦" : "delete" },
    { code: "End", label: "end" },
    { code: "PageDown", label: "pg dn" },
  ],
  // Two blank rows so the inverted-T lands where it does on a real keyboard:
  // ↑ level with the shift row, ←↓→ level with the bottom (control) row.
  [GAP, GAP, GAP],
  [GAP, GAP, GAP],
  [GAP, { code: "ArrowUp", label: "↑" }, GAP],
  [
    { code: "ArrowLeft", label: "←" },
    { code: "ArrowDown", label: "↓" },
    { code: "ArrowRight", label: "→" },
  ],
];

/** Every code the drawn keyboard can show, so we know what needs the overflow list. */
const DRAWN_CODES = new Set(
  [...MAIN_ROWS, ...NAV_ROWS].flat().map((k) => k.code).filter(Boolean)
);

interface Bound {
  /** What fits on a key. */
  text: string;
  /** The full command name, for the tooltip. */
  full: string;
}

/** combo → what it does, from the bindings in effect right now. A combo bound
    to two commands (a conflict) shows the first; the Shortcuts tab is where
    that gets resolved. */
function bindingIndex(): Map<string, Bound> {
  const m = new Map<string, Bound>();
  for (const c of COMMANDS) {
    for (const combo of state.keybindings[c.id] ?? [])
      if (!m.has(combo)) m.set(combo, { text: c.short ?? c.label, full: c.label });
  }
  return m;
}

function comboFor(mods: Set<string>, code: string): string {
  const parts = MOD_ORDER.filter((m) => mods.has(m));
  parts.push(code);
  return parts.join("+");
}

/** The map is usually opened *with* a modifier down (⌘K), so the first thing
    that would happen is the ⌘ layer showing and then snapping to the base layer
    a moment later when ⌘ comes up — a visible flash. Ignore the physical
    modifier state for this long after opening; tracking picks up from the next
    key event after that. */
const MOD_GRACE_MS = 1000;

let closeOpen: (() => void) | null = null;

/** ⌘K: open the map, or close it if it's already up. */
export function toggleKeyboardMap(): void {
  if (closeOpen) closeOpen();
  else openKeyboardMap();
}

export function openKeyboardMap(): void {
  if (closeOpen) return;

  const bindings = bindingIndex();
  const sticky = new Set<string>(); // modifiers clicked on the drawn keyboard
  let held = new Set<string>(); // modifiers physically down right now
  const openedAt = Date.now();
  const settling = (): boolean => Date.now() - openedAt < MOD_GRACE_MS;

  const overlay = document.createElement("div");
  overlay.className = "kbmap-overlay";
  const panel = document.createElement("div");
  panel.className = "kbmap";
  panel.tabIndex = -1;

  const head = document.createElement("div");
  head.className = "kbmap-head";
  const title = document.createElement("div");
  title.className = "kbmap-title";
  const sub = document.createElement("div");
  sub.className = "kbmap-sub";
  const closeBtn = document.createElement("button");
  closeBtn.className = "kbmap-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (Esc)";
  head.append(title, sub, closeBtn);

  const board = document.createElement("div");
  board.className = "kbmap-board";
  const main = document.createElement("div");
  main.className = "kbmap-main";
  const nav = document.createElement("div");
  nav.className = "kbmap-nav";
  board.append(main, nav);

  const extras = document.createElement("div");
  extras.className = "kbmap-extras";

  panel.append(head, board, extras);
  overlay.append(panel);
  document.body.append(overlay);

  const active = (): Set<string> => new Set([...held, ...sticky]);

  const buildRow = (row: KeyDef[], into: HTMLElement, mods: Set<string>): void => {
    const r = document.createElement("div");
    r.className = "kbmap-row";
    for (const k of row) {
      const cell = document.createElement("div");
      if (!k.code) {
        cell.className = "kbkey kbkey-gap";
        r.append(cell);
        continue;
      }
      cell.className = "kbkey";
      cell.style.flex = `${k.w ?? 1} 0 0`;
      if (k.mod) {
        cell.classList.add("kbkey-mod");
        if (mods.has(k.mod)) cell.classList.add("is-on");
        if (sticky.has(k.mod)) cell.classList.add("is-sticky");
        cell.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (sticky.has(k.mod!)) sticky.delete(k.mod!);
          else sticky.add(k.mod!);
          render();
        });
      } else {
        const cmd = bindings.get(comboFor(mods, k.code));
        if (cmd) {
          cell.classList.add("is-bound");
          const c = document.createElement("span");
          c.className = "kbkey-cmd";
          c.textContent = cmd.text;
          cell.append(c);
          cell.title = cmd.full;
        }
      }
      const lab = document.createElement("span");
      lab.className = "kbkey-label";
      lab.textContent = k.label;
      cell.prepend(lab);
      r.append(cell);
    }
    into.append(r);
  };

  const render = (): void => {
    const mods = active();
    main.replaceChildren();
    nav.replaceChildren();
    for (const row of MAIN_ROWS) buildRow(row, main, mods);
    for (const row of NAV_ROWS) buildRow(row, nav, mods);

    // Anything bound on this layer whose key isn't on the drawn keyboard
    // (numpad, Insert on a Mac, …) — listed so the map never silently hides one.
    const prefix = MOD_ORDER.filter((m) => mods.has(m));
    const rest: string[] = [];
    let onLayer = 0;
    for (const [combo, bound] of bindings) {
      const parts = combo.split("+");
      const code = parts.pop()!;
      if (parts.length !== prefix.length || !parts.every((p, i) => p === prefix[i])) continue;
      onLayer++;
      if (!DRAWN_CODES.has(code)) rest.push(`${comboLabel(combo)} ${bound.full}`);
    }

    const layer = prefix.length
      ? prefix.map((m) => MOD_LABEL[m]).join(isMac ? "" : "+")
      : "No modifier";
    title.textContent = `Keyboard — ${layer}`;
    sub.textContent = `${onLayer} shortcut${onLayer === 1 ? "" : "s"} on this layer · hold or click ${MOD_ORDER.map(
      (m) => MOD_LABEL[m]
    ).join(" ")} to switch · Esc to close`;
    extras.textContent = rest.length ? `Not on this keyboard: ${rest.join(" · ")}` : "";
  };

  const modsFromEvent = (e: KeyboardEvent): Set<string> => {
    const s = new Set<string>();
    if (e.metaKey) s.add("Meta");
    if (e.ctrlKey) s.add("Ctrl");
    if (e.altKey) s.add("Alt");
    if (e.shiftKey) s.add("Shift");
    return s;
  };

  // Capture on window, and stopImmediatePropagation: the app's dispatcher also
  // listens on window, and plain stopPropagation does NOT stop other listeners
  // on the same node — so a shortcut could still fire underneath. Keys only
  // preview while the map is up.
  const onKeyDown = (e: KeyboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.key === "Escape") {
      close();
      return;
    }
    // The same combo that opened it closes it again.
    const combo = comboFor(modsFromEvent(e), e.code);
    if ((state.keybindings.keyboardMap ?? []).includes(combo)) {
      close();
      return;
    }
    if (settling()) return;
    held = modsFromEvent(e);
    render();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    e.stopImmediatePropagation();
    if (settling()) return;
    held = modsFromEvent(e);
    render();
  };
  const onBlur = (): void => {
    held = new Set();
    render();
  };

  function close(): void {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    overlay.remove();
    closeOpen = null;
  }
  closeOpen = close;

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);

  render();
  panel.focus();
}
