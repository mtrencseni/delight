// The keyboard-command registry. Every shortcut in the app is a command with a
// stable id, a human label, a group (for the Shortcuts tab), and default key
// bindings. Effective bindings live in state.keybindings (persisted); the
// keyboard handler matches a pressed combo against them and runs the command.

import { MOD, isMac } from "./platform";

export type CommandId =
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "cycleTabs"
  | "openSettings"
  | "switchPane"
  | "cursorUp"
  | "cursorDown"
  | "expand"
  | "collapse"
  | "nextVisited"
  | "prevVisited"
  | "pageUp"
  | "pageDown"
  | "cursorHome"
  | "cursorEnd"
  | "open"
  | "up"
  | "editFile"
  | "copyToOther"
  | "moveToOther"
  | "rename"
  | "newFolder"
  | "trash"
  | "toggleMark"
  | "markItem"
  | "unmarkItem"
  | "selectUp"
  | "selectDown"
  | "selectAll"
  | "selectGroup"
  | "unselectGroup"
  | "sortName"
  | "sortExt"
  | "sortSize"
  | "sortCreated"
  | "sortModified"
  | "viewList"
  | "viewChips"
  | "viewGrid"
  | "toggleSingle"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleHidden"
  | "preview"
  | "closePreview"
  | "devtools"
  | "favoritesLeft"
  | "favoritesRight"
  | "drivesLeft"
  | "drivesRight"
  | "enterArchive";

export interface Command {
  id: CommandId;
  label: string;
  group: string;
  /** Default bindings, as canonical combo strings (e.g. `${MOD}+KeyT`). MOD is
   *  "Meta" (⌘) on macOS and "Ctrl" everywhere else, so every ⌘-shortcut maps to
   *  Ctrl on Windows/Linux. Genuine Ctrl bindings (e.g. Ctrl+Tab) stay literal. */
  defaults: string[];
}

export const COMMANDS: Command[] = [
  // Tabs
  { id: "newTab", label: "New tab", group: "Tabs", defaults: [`${MOD}+KeyT`] },
  { id: "closeTab", label: "Close tab", group: "Tabs", defaults: [`${MOD}+KeyW`] },
  { id: "nextTab", label: "Next tab", group: "Tabs", defaults: [`${MOD}+Shift+BracketRight`, "Ctrl+Tab"] },
  { id: "prevTab", label: "Previous tab", group: "Tabs", defaults: [`${MOD}+Shift+BracketLeft`, "Ctrl+Shift+Tab"] },
  { id: "cycleTabs", label: "Cycle tabs", group: "Tabs", defaults: [`${MOD}+Backquote`] },
  { id: "openSettings", label: "Open settings", group: "Tabs", defaults: [`${MOD}+Comma`] },

  // Panes & navigation
  { id: "switchPane", label: "Switch pane", group: "Panes & navigation", defaults: ["Tab"] },
  { id: "cursorUp", label: "Move up", group: "Panes & navigation", defaults: ["ArrowUp"] },
  { id: "cursorDown", label: "Move down", group: "Panes & navigation", defaults: ["ArrowDown"] },
  // Plain → / ← jump between recent folders (nextVisited/prevVisited); ⌘→ / ⌘←
  // (Ctrl→ / Ctrl← on Windows) open / close the in-list tree.
  { id: "expand", label: "Expand / open folder", group: "Panes & navigation", defaults: [`${MOD}+ArrowRight`] },
  { id: "collapse", label: "Collapse / to parent", group: "Panes & navigation", defaults: [`${MOD}+ArrowLeft`] },
  { id: "nextVisited", label: "Next recent folder", group: "Panes & navigation", defaults: ["ArrowRight"] },
  { id: "prevVisited", label: "Previous recent folder", group: "Panes & navigation", defaults: ["ArrowLeft"] },
  { id: "pageUp", label: "Page up", group: "Panes & navigation", defaults: ["PageUp"] },
  { id: "pageDown", label: "Page down", group: "Panes & navigation", defaults: ["PageDown"] },
  { id: "cursorHome", label: "Jump to top", group: "Panes & navigation", defaults: ["Home", `${MOD}+ArrowUp`] },
  { id: "cursorEnd", label: "Jump to bottom", group: "Panes & navigation", defaults: ["End", `${MOD}+ArrowDown`] },
  { id: "open", label: "Open", group: "Panes & navigation", defaults: ["Enter"] },
  { id: "up", label: "Go up a folder", group: "Panes & navigation", defaults: ["Backspace"] },
  // Archives are entered explicitly, so plain Enter on a .docx/.apk still opens
  // it in its app rather than showing the zip guts.
  { id: "enterArchive", label: "Open archive as folder", group: "Panes & navigation", defaults: [`${MOD}+Enter`] },

  // File operations. Windows/Linux use the classic Norton Commander / Total
  // Commander F-keys (F4 edit … F8 delete); macOS uses the number row instead,
  // since the F-keys there need the Fn modifier to fire as a single press.
  { id: "editFile", label: "Edit (open in Buffers)", group: "File operations", defaults: isMac ? ["Digit4"] : ["F4"] },
  { id: "copyToOther", label: "Copy to other pane", group: "File operations", defaults: isMac ? ["Digit5"] : ["F5"] },
  { id: "moveToOther", label: "Move to other pane", group: "File operations", defaults: isMac ? ["Digit6"] : ["F6"] },
  { id: "rename", label: "Rename", group: "File operations", defaults: isMac ? ["Shift+Digit6"] : ["Shift+F6"] },
  { id: "newFolder", label: "New folder", group: "File operations", defaults: isMac ? ["Digit7"] : ["F7"] },
  { id: "trash", label: "Move to Trash", group: "File operations", defaults: isMac ? ["Digit8"] : ["F8"] },

  // Selection
  // Insert marks the current item and steps down (Total Commander). On Mac
  // laptops without an Insert key, rebind it in the Shortcuts tab.
  { id: "toggleMark", label: "Select / deselect item", group: "Selection", defaults: ["Insert"] },
  { id: "markItem", label: "Select current (stay)", group: "Selection", defaults: ["Shift+ArrowRight"] },
  { id: "unmarkItem", label: "Deselect current (stay)", group: "Selection", defaults: ["Shift+ArrowLeft"] },
  { id: "selectUp", label: "Select current, move up", group: "Selection", defaults: ["Shift+ArrowUp"] },
  { id: "selectDown", label: "Select current, move down", group: "Selection", defaults: ["Shift+ArrowDown"] },
  { id: "selectAll", label: "Select all / deselect all", group: "Selection", defaults: [`${MOD}+KeyA`] },
  // Total Commander's grey +/− "select group": a wildcard mask dialog. Both the
  // shifted and unshifted key are bound (= and +, - and _) so it fires whether
  // or not Shift is held, plus the numpad keys Mac laptops don't have.
  {
    id: "selectGroup",
    label: "Select by mask…",
    group: "Selection",
    defaults: ["Equal", "Shift+Equal", "NumpadAdd"],
  },
  {
    id: "unselectGroup",
    label: "Deselect by mask…",
    group: "Selection",
    defaults: ["Minus", "Shift+Minus", "NumpadSubtract"],
  },

  // Sorting
  { id: "sortName", label: "Sort by name", group: "Sorting", defaults: [`${MOD}+KeyN`] },
  { id: "sortExt", label: "Sort by extension", group: "Sorting", defaults: [`${MOD}+KeyE`] },
  { id: "sortSize", label: "Sort by size", group: "Sorting", defaults: [`${MOD}+KeyS`] },
  // ⌘C is the Chips-view shortcut; sort-by-created moved to ⌘⇧C.
  { id: "sortCreated", label: "Sort by created", group: "Sorting", defaults: [`${MOD}+Shift+KeyC`] },
  { id: "sortModified", label: "Sort by modified", group: "Sorting", defaults: [`${MOD}+KeyM`] },

  // View
  { id: "viewList", label: "List view", group: "View", defaults: [`${MOD}+KeyL`] },
  { id: "viewChips", label: "Chips view", group: "View", defaults: [`${MOD}+KeyC`] },
  { id: "viewGrid", label: "Icon view", group: "View", defaults: [`${MOD}+KeyI`] },
  { id: "toggleSingle", label: "Single-pane view", group: "View", defaults: [`${MOD}+KeyP`] },
  { id: "zoomIn", label: "Zoom in", group: "View", defaults: [`${MOD}+Equal`, `${MOD}+NumpadAdd`] },
  { id: "zoomOut", label: "Zoom out", group: "View", defaults: [`${MOD}+Minus`, `${MOD}+NumpadSubtract`] },
  { id: "zoomReset", label: "Reset zoom", group: "View", defaults: [`${MOD}+Digit0`, `${MOD}+Numpad0`] },
  { id: "toggleHidden", label: "Toggle hidden files", group: "View", defaults: [`${MOD}+Shift+Period`] },
  // Space previews everywhere; the secondary key is F3 ("view") on Windows/Linux,
  // the number row (⌘-free "3") on macOS — matching the file-op key scheme above.
  { id: "preview", label: "Preview", group: "View", defaults: isMac ? ["Space", "Digit3"] : ["Space", "F3"] },
  { id: "closePreview", label: "Close preview", group: "View", defaults: ["Escape"] },
  { id: "devtools", label: "Developer tools", group: "View", defaults: [`${MOD}+Alt+KeyI`] },

  // Favorites
  { id: "favoritesLeft", label: "Favorites — left pane", group: "Favorites", defaults: [`${MOD}+Digit1`] },
  { id: "favoritesRight", label: "Favorites — right pane", group: "Favorites", defaults: [`${MOD}+Digit2`] },

  // Drives (Windows/Linux only — a single root on macOS makes a drive picker
  // meaningless, so these commands aren't registered there). Alt+F1/F2 open a
  // drive-letter dropdown for the left/right pane, à la Total Commander.
  ...(isMac
    ? []
    : ([
        { id: "drivesLeft", label: "Drives — left pane", group: "Panes & navigation", defaults: ["Alt+F1"] },
        { id: "drivesRight", label: "Drives — right pane", group: "Panes & navigation", defaults: ["Alt+F2"] },
      ] as Command[])),
];

/** Group order for the Shortcuts tab (first-seen order in COMMANDS). */
export const COMMAND_GROUPS: string[] = [...new Set(COMMANDS.map((c) => c.group))];

export const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

/** Encode a keydown as a canonical combo string, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

/** True if the combo carries a "strong" modifier (fires even while typing). */
export function comboHasStrongMod(combo: string): boolean {
  return combo.split("+").some((p) => p === "Meta" || p === "Ctrl" || p === "Alt");
}

// macOS shows glyphs joined tight (⌘⇧.); Windows/Linux spell the modifiers out
// and join with "+" (Ctrl+Shift+.). MOD_SYMBOL + the join in comboLabel switch
// on isMac so every displayed shortcut reads naturally per platform.
const MOD_SYMBOL: Record<string, string> = isMac
  ? { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
  : { Meta: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const CODE_SYMBOL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  NumpadAdd: "+",
  NumpadSubtract: "−",
  NumpadMultiply: "×",
  NumpadDivide: "÷",
  NumpadDecimal: ".",
  NumpadEnter: "↩",
};

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return CODE_SYMBOL[code] ?? code;
}

/** Human-readable label for a combo: "Meta+Shift+Period" -> "⌘⇧." on macOS,
 *  "Ctrl+Shift+." (words, "+"-joined) on Windows/Linux. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => MOD_SYMBOL[p] ?? p);
  return isMac ? mods.join("") + keyLabel(key) : [...mods, keyLabel(key)].join("+");
}

export function defaultKeybindings(): Record<CommandId, string[]> {
  const o = {} as Record<CommandId, string[]>;
  for (const c of COMMANDS) o[c.id] = [...c.defaults];
  return o;
}

/** Merge a persisted map over the defaults (so new commands get their default). */
export function mergeKeybindings(saved: unknown): Record<CommandId, string[]> {
  const base = defaultKeybindings();
  if (saved && typeof saved === "object") {
    const s = saved as Record<string, unknown>;
    for (const c of COMMANDS) {
      const v = s[c.id];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) base[c.id] = v as string[];
    }
    // Persisted configs store the FULL binding set, so newly-added default
    // shortcuts stay shadowed by an older snapshot. Adopt these for configs that
    // predate them — but only if the user hasn't since bound that combo to some
    // other command. (⌘↑/⌘↓ "jump to top/bottom"; the unshifted "=" and shifted
    // "_" twins of the +/− select-by-mask keys.)
    for (const [id, combo] of [
      ["cursorHome", `${MOD}+ArrowUp`],
      ["cursorEnd", `${MOD}+ArrowDown`],
      ["selectGroup", "Equal"],
      ["unselectGroup", "Shift+Minus"],
    ] as const) {
      const usedElsewhere = (Object.entries(base) as [CommandId, string[]][]).some(
        ([cid, combos]) => cid !== id && combos.includes(combo)
      );
      if (!usedElsewhere && !base[id].includes(combo)) base[id].push(combo);
    }
    // ⌘C used to be "sort by created" but is now the Chips-view shortcut. If a
    // saved config still holds the old ⌘C-only binding, move sort-created to ⌘⇧C
    // so ⌘C is free for viewChips (whose default we then leave intact).
    if (base.sortCreated.length === 1 && base.sortCreated[0] === `${MOD}+KeyC`) {
      base.sortCreated = [`${MOD}+Shift+KeyC`];
    }
    // Single-pane view's default moved ⌘⇧P → ⌘P; adopt it for untouched configs.
    if (base.toggleSingle.length === 1 && base.toggleSingle[0] === `${MOD}+Shift+KeyP`) {
      base.toggleSingle = [`${MOD}+KeyP`];
    }
    // Plain →/← now jump between recent folders (nextVisited/prevVisited); the
    // in-list tree moved to ⌘→ / ⌘←. Strip the old plain-arrow bindings off
    // expand/collapse, then adopt the ⌘-arrow defaults for configs that predate
    // them (unless the user has bound those combos elsewhere).
    if (base.expand.includes("ArrowRight")) base.expand = base.expand.filter((c) => c !== "ArrowRight");
    if (base.collapse.includes("ArrowLeft")) base.collapse = base.collapse.filter((c) => c !== "ArrowLeft");
    // Adopt newly-added default combos for configs that predate them (unless the
    // user has since bound that combo elsewhere): ⌘→/⌘← for the tree, and `3`
    // as a second Preview key alongside Space.
    for (const [id, combo] of [
      ["expand", `${MOD}+ArrowRight`],
      ["collapse", `${MOD}+ArrowLeft`],
      ["preview", isMac ? "Digit3" : "F3"],
    ] as const) {
      const usedElsewhere = (Object.entries(base) as [CommandId, string[]][]).some(
        ([cid, combos]) => cid !== id && combos.includes(combo)
      );
      if (!usedElsewhere && !base[id].includes(combo)) base[id].push(combo);
    }
    // Windows/Linux: the file-op defaults moved from the macOS number row to the
    // Norton/Total-Commander F-keys. Upgrade a config saved by an early build
    // that still holds the sole old number binding (a user who rebound the
    // command has a different value and is left alone).
    if (!isMac) {
      for (const [id, oldCombo, newCombo] of [
        ["copyToOther", "Digit5", "F5"],
        ["moveToOther", "Digit6", "F6"],
        ["rename", "Shift+Digit6", "Shift+F6"],
        ["newFolder", "Digit7", "F7"],
        ["trash", "Digit8", "F8"],
      ] as const) {
        if (base[id].length === 1 && base[id][0] === oldCombo) base[id] = [newCombo];
      }
    }
  }
  return base;
}
