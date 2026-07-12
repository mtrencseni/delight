// The keyboard-command registry. Every shortcut in the app is a command with a
// stable id, a human label, a group (for the Shortcuts tab), and default key
// bindings. Effective bindings live in state.keybindings (persisted); the
// keyboard handler matches a pressed combo against them and runs the command.

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
  | "pageUp"
  | "pageDown"
  | "cursorHome"
  | "cursorEnd"
  | "open"
  | "up"
  | "selectUp"
  | "selectDown"
  | "selectAll"
  | "sortName"
  | "sortExt"
  | "sortSize"
  | "sortCreated"
  | "sortModified"
  | "viewList"
  | "viewChips"
  | "viewGrid"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleHidden"
  | "preview"
  | "closePreview"
  | "devtools"
  | "favoritesLeft"
  | "favoritesRight";

export interface Command {
  id: CommandId;
  label: string;
  group: string;
  /** Default bindings, as canonical combo strings (e.g. "Meta+KeyT"). */
  defaults: string[];
}

export const COMMANDS: Command[] = [
  // Tabs
  { id: "newTab", label: "New tab", group: "Tabs", defaults: ["Meta+KeyT"] },
  { id: "closeTab", label: "Close tab", group: "Tabs", defaults: ["Meta+KeyW"] },
  { id: "nextTab", label: "Next tab", group: "Tabs", defaults: ["Meta+Shift+BracketRight", "Ctrl+Tab"] },
  { id: "prevTab", label: "Previous tab", group: "Tabs", defaults: ["Meta+Shift+BracketLeft", "Ctrl+Shift+Tab"] },
  { id: "cycleTabs", label: "Cycle tabs", group: "Tabs", defaults: ["Meta+Backquote"] },
  { id: "openSettings", label: "Open settings", group: "Tabs", defaults: ["Meta+Comma"] },

  // Panes & navigation
  { id: "switchPane", label: "Switch pane", group: "Panes & navigation", defaults: ["Tab"] },
  { id: "cursorUp", label: "Move up", group: "Panes & navigation", defaults: ["ArrowUp"] },
  { id: "cursorDown", label: "Move down", group: "Panes & navigation", defaults: ["ArrowDown"] },
  { id: "expand", label: "Expand / open folder", group: "Panes & navigation", defaults: ["ArrowRight"] },
  { id: "collapse", label: "Collapse / to parent", group: "Panes & navigation", defaults: ["ArrowLeft"] },
  { id: "pageUp", label: "Page up", group: "Panes & navigation", defaults: ["PageUp"] },
  { id: "pageDown", label: "Page down", group: "Panes & navigation", defaults: ["PageDown"] },
  { id: "cursorHome", label: "Jump to top", group: "Panes & navigation", defaults: ["Home", "Meta+ArrowUp"] },
  { id: "cursorEnd", label: "Jump to bottom", group: "Panes & navigation", defaults: ["End", "Meta+ArrowDown"] },
  { id: "open", label: "Open", group: "Panes & navigation", defaults: ["Enter"] },
  { id: "up", label: "Go up a folder", group: "Panes & navigation", defaults: ["Backspace"] },

  // Selection
  { id: "selectUp", label: "Extend selection up", group: "Selection", defaults: ["Shift+ArrowUp"] },
  { id: "selectDown", label: "Extend selection down", group: "Selection", defaults: ["Shift+ArrowDown"] },
  { id: "selectAll", label: "Select all", group: "Selection", defaults: ["Meta+KeyA"] },

  // Sorting
  { id: "sortName", label: "Sort by name", group: "Sorting", defaults: ["Meta+KeyN"] },
  { id: "sortExt", label: "Sort by extension", group: "Sorting", defaults: ["Meta+KeyE"] },
  { id: "sortSize", label: "Sort by size", group: "Sorting", defaults: ["Meta+KeyS"] },
  // ⌘C is the Chips-view shortcut; sort-by-created moved to ⌘⇧C.
  { id: "sortCreated", label: "Sort by created", group: "Sorting", defaults: ["Meta+Shift+KeyC"] },
  { id: "sortModified", label: "Sort by modified", group: "Sorting", defaults: ["Meta+KeyM"] },

  // View
  { id: "viewList", label: "List view", group: "View", defaults: ["Meta+KeyL"] },
  { id: "viewChips", label: "Chips view", group: "View", defaults: ["Meta+KeyC"] },
  { id: "viewGrid", label: "Icon view", group: "View", defaults: ["Meta+KeyI"] },
  { id: "zoomIn", label: "Zoom in", group: "View", defaults: ["Meta+Equal", "Meta+NumpadAdd"] },
  { id: "zoomOut", label: "Zoom out", group: "View", defaults: ["Meta+Minus", "Meta+NumpadSubtract"] },
  { id: "zoomReset", label: "Reset zoom", group: "View", defaults: ["Meta+Digit0", "Meta+Numpad0"] },
  { id: "toggleHidden", label: "Toggle hidden files", group: "View", defaults: ["Meta+Shift+Period"] },
  { id: "preview", label: "Preview", group: "View", defaults: ["Space"] },
  { id: "closePreview", label: "Close preview", group: "View", defaults: ["Escape"] },
  { id: "devtools", label: "Developer tools", group: "View", defaults: ["Meta+Alt+KeyI"] },

  // Favorites
  { id: "favoritesLeft", label: "Favorites — left pane", group: "Favorites", defaults: ["Meta+Digit1"] },
  { id: "favoritesRight", label: "Favorites — right pane", group: "Favorites", defaults: ["Meta+Digit2"] },
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

const MOD_SYMBOL: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
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

/** Human-readable label for a combo, e.g. "Meta+Shift+Period" -> "⌘⇧.". */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return parts.map((p) => MOD_SYMBOL[p] ?? p).join("") + keyLabel(key);
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
    // shortcuts stay shadowed by an older snapshot. Adopt the ⌘↑ / ⌘↓
    // "jump to top/bottom" combos for configs that predate them — but only if
    // the user hasn't since bound that combo to some other command.
    for (const [id, combo] of [
      ["cursorHome", "Meta+ArrowUp"],
      ["cursorEnd", "Meta+ArrowDown"],
    ] as const) {
      const usedElsewhere = (Object.entries(base) as [CommandId, string[]][]).some(
        ([cid, combos]) => cid !== id && combos.includes(combo)
      );
      if (!usedElsewhere && !base[id].includes(combo)) base[id].push(combo);
    }
    // ⌘C used to be "sort by created" but is now the Chips-view shortcut. If a
    // saved config still holds the old ⌘C-only binding, move sort-created to ⌘⇧C
    // so ⌘C is free for viewChips (whose default we then leave intact).
    if (base.sortCreated.length === 1 && base.sortCreated[0] === "Meta+KeyC") {
      base.sortCreated = ["Meta+Shift+KeyC"];
    }
  }
  return base;
}
