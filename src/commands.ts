// The keyboard-command registry. Every shortcut in the app is a command with a
// stable id, a human label, a group (for the Shortcuts tab), and default key
// bindings. Effective bindings live in state.keybindings (persisted); the
// keyboard handler matches a pressed combo against them and runs the command.

import { MOD, isMac } from "./platform";
import { isWeb } from "./target";

export type CommandId =
  | "resetLayout"
  | "downloadItems"
  | "uploadFiles"
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
  | "desktopNewest"
  | "showInfo"
  | "open"
  | "up"
  | "find"
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
  | "focusPath"
  | "connectNetwork"
  | "viewList"
  | "viewChips"
  | "viewGrid"
  | "toggleSingle"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleHidden"
  | "keyboardMap"
  | "preview"
  | "closePreview"
  | "devtools"
  | "favoritesLeft"
  | "favoritesRight"
  | "drivesLeft"
  | "drivesRight"
  | "enterArchive"
  | "pack"
  | "unpack";

export interface Command {
  id: CommandId;
  label: string;
  /** Compact label for the keyboard map, where a key is only so wide. The full
      `label` still shows in the Shortcuts tab and as the key's tooltip. */
  short?: string;
  group: string;
  /** Default bindings, as canonical combo strings (e.g. `${MOD}+KeyT`). MOD is
   *  "Meta" (⌘) on macOS and "Ctrl" everywhere else, so every ⌘-shortcut maps to
   *  Ctrl on Windows/Linux. Genuine Ctrl bindings (e.g. Ctrl+Tab) stay literal. */
  defaults: string[];
}

export const COMMANDS: Command[] = [
  // Tabs
  { id: "newTab", label: "New tab", group: "Tabs", defaults: [`${MOD}+KeyT`] },
  // Ctrl+F4 is the Windows close-document convention (and has been since MDI);
  // it sits alongside Ctrl+W rather than replacing it. No macOS equivalent —
  // ⌘F4 means nothing there, so the Mac keeps ⌘W alone.
  { id: "closeTab", label: "Close tab", group: "Tabs", defaults: isMac ? [`${MOD}+KeyW`] : [`${MOD}+KeyW`, "Ctrl+F4"] },
  { id: "nextTab", label: "Next tab", group: "Tabs", defaults: [`${MOD}+Shift+BracketRight`, "Ctrl+Tab"] },
  { id: "prevTab", label: "Previous tab", short: "Prev tab", group: "Tabs", defaults: [`${MOD}+Shift+BracketLeft`, "Ctrl+Shift+Tab"] },
  { id: "cycleTabs", label: "Cycle tabs", group: "Tabs", defaults: [`${MOD}+Backquote`] },
  { id: "openSettings", label: "Open settings", short: "Settings", group: "Tabs", defaults: [`${MOD}+Comma`] },

  // Panes & navigation
  { id: "switchPane", label: "Switch pane", group: "Panes & navigation", defaults: ["Tab"] },
  { id: "cursorUp", label: "Move up", group: "Panes & navigation", defaults: ["ArrowUp"] },
  { id: "cursorDown", label: "Move down", group: "Panes & navigation", defaults: ["ArrowDown"] },
  // Plain → / ← jump between recent folders (nextVisited/prevVisited); ⌘→ / ⌘←
  // (Ctrl→ / Ctrl← on Windows) open / close the in-list tree.
  { id: "expand", label: "Expand / open folder", short: "Expand", group: "Panes & navigation", defaults: [`${MOD}+ArrowRight`] },
  { id: "collapse", label: "Collapse / to parent", short: "Collapse", group: "Panes & navigation", defaults: [`${MOD}+ArrowLeft`] },
  { id: "nextVisited", label: "Next recent folder", short: "Next recent", group: "Panes & navigation", defaults: ["ArrowRight"] },
  { id: "prevVisited", label: "Previous recent folder", short: "Prev recent", group: "Panes & navigation", defaults: ["ArrowLeft"] },
  { id: "pageUp", label: "Page up", group: "Panes & navigation", defaults: ["PageUp"] },
  { id: "pageDown", label: "Page down", group: "Panes & navigation", defaults: ["PageDown"] },
  { id: "cursorHome", label: "Jump to top", short: "Top", group: "Panes & navigation", defaults: ["Home", `${MOD}+ArrowUp`] },
  { id: "cursorEnd", label: "Jump to bottom", short: "Bottom", group: "Panes & navigation", defaults: ["End", `${MOD}+ArrowDown`] },
  // One key for the whole screenshot-then-drag flow: take a shot, ⌥S, drag it
  // out of the pane. Goes to the Desktop, newest first, cursor on the newest
  // file, preview open — see main.ts showNewestOnDesktop.
  { id: "desktopNewest", label: "Newest file on the Desktop", short: "Desktop", group: "Panes & navigation", defaults: ["Alt+KeyS"] },
  // ⌘I is the Finder gesture for this, which is the whole point of matching it.
  { id: "showInfo", label: "Get Info in Finder", short: "Get Info", group: "Panes & navigation", defaults: [`${MOD}+KeyI`] },
  { id: "open", label: "Open", group: "Panes & navigation", defaults: ["Enter"] },
  { id: "up", label: "Go up a folder", short: "Up a folder", group: "Panes & navigation", defaults: ["Backspace"] },
  // Quick-search inside the active pane. Binding it here is also what stops the
  // webview's own find bar from popping up (the handler preventDefaults it).
  { id: "find", label: "Find file in pane", short: "Find", group: "Panes & navigation", defaults: [`${MOD}+KeyF`] },
  // Archives are entered explicitly, so plain Enter on a .docx/.apk still opens
  // it in its app rather than showing the zip guts.
  { id: "enterArchive", label: "Open archive as folder", short: "Archive", group: "Panes & navigation", defaults: [`${MOD}+Enter`] },

  // File operations. Windows/Linux use the classic Norton Commander / Total
  // Commander F-keys (F4 edit … F8 delete); macOS uses the number row instead,
  // since the F-keys there need the Fn modifier to fire as a single press.
  { id: "editFile", label: "Edit (open in Buffers)", short: "Edit", group: "File operations", defaults: isMac ? ["Digit4"] : ["F4"] },
  { id: "copyToOther", label: "Copy to other pane", short: "Copy", group: "File operations", defaults: isMac ? ["Digit5"] : ["F5"] },
  { id: "moveToOther", label: "Move to other pane", short: "Move", group: "File operations", defaults: isMac ? ["Digit6"] : ["F6"] },
  { id: "rename", label: "Rename", group: "File operations", defaults: isMac ? ["Shift+Digit6"] : ["Shift+F6"] },
  { id: "newFolder", label: "New folder", group: "File operations", defaults: isMac ? ["Digit7"] : ["F7"] },
  { id: "trash", label: "Move to Trash", short: "Trash", group: "File operations", defaults: isMac ? ["Digit8"] : ["F8"] },
  { id: "pack", label: "Pack into zip", short: "Pack", group: "File operations", defaults: isMac ? ["Alt+Digit5"] : ["Alt+F5"] },
  { id: "unpack", label: "Unpack archive", short: "Unpack", group: "File operations", defaults: isMac ? ["Alt+Digit9"] : ["Alt+F9"] },

  // Selection
  // Insert marks the current item and steps down (Total Commander). On Mac
  // laptops without an Insert key, rebind it in the Shortcuts tab.
  { id: "toggleMark", label: "Select / deselect item", short: "Mark", group: "Selection", defaults: ["Insert"] },
  { id: "markItem", label: "Select current (stay)", short: "Select", group: "Selection", defaults: ["Shift+ArrowRight"] },
  { id: "unmarkItem", label: "Deselect current (stay)", short: "Deselect", group: "Selection", defaults: ["Shift+ArrowLeft"] },
  { id: "selectUp", label: "Select current, move up", short: "Select ↑", group: "Selection", defaults: ["Shift+ArrowUp"] },
  { id: "selectDown", label: "Select current, move down", short: "Select ↓", group: "Selection", defaults: ["Shift+ArrowDown"] },
  { id: "selectAll", label: "Select all / deselect all", short: "Select all", group: "Selection", defaults: [`${MOD}+KeyA`] },
  // Total Commander's grey +/− "select group": a wildcard mask dialog. Both the
  // shifted and unshifted key are bound (= and +, - and _) so it fires whether
  // or not Shift is held, plus the numpad keys Mac laptops don't have.
  {
    id: "selectGroup",
    label: "Select by mask…",
    short: "Mask +",
    group: "Selection",
    defaults: ["Equal", "Shift+Equal", "NumpadAdd"],
  },
  {
    id: "unselectGroup",
    label: "Deselect by mask…",
    short: "Mask −",
    group: "Selection",
    defaults: ["Minus", "Shift+Minus", "NumpadSubtract"],
  },

  // Sorting
  { id: "sortName", label: "Sort by name", short: "Sort name", group: "Sorting", defaults: [`${MOD}+KeyN`] },
  { id: "sortExt", label: "Sort by extension", short: "Sort ext", group: "Sorting", defaults: [`${MOD}+KeyE`] },
  { id: "sortSize", label: "Sort by size", short: "Sort size", group: "Sorting", defaults: [`${MOD}+KeyS`] },
  // ⌘C is the Chips-view shortcut; sort-by-created moved to ⌘⇧C.
  // Created returns to ⌘C, where it started: with the views on ⌘⇧, every sort
  // key is now the unshifted initial of what it sorts by (N/E/S/C/M).
  { id: "sortCreated", label: "Sort by created", short: "Sort created", group: "Sorting", defaults: [`${MOD}+KeyC`] },
  { id: "sortModified", label: "Sort by modified", short: "Sort modified", group: "Sorting", defaults: [`${MOD}+KeyM`] },

  // View
  // ⌘L is the browser's "focus the address bar", and that muscle memory beats
  // any view shortcut — so List view moved to ⌘⇧L, keeping its mnemonic.
  // migrateBindings() clears a ⌘L saved against viewList by an older build.
  { id: "focusPath", label: "Focus the path bar", short: "Path bar", group: "Panes & navigation", defaults: [`${MOD}+KeyL`] },
  // No default: every obvious combo is taken, and the path bar's globe button
  // is the discoverable route. Bindable in the Shortcuts tab like anything else.
  { id: "connectNetwork", label: "Connect to a server", short: "Connect", group: "Panes & navigation", defaults: [] },
  // All three views share one shape — ⌘⇧ + a letter — so the set is learned as
  // a group rather than three unrelated keys. That frees the unshifted ⌘C and
  // ⌘I, which go back to sorting by created and to Get Info.
  { id: "viewList", label: "List view", group: "View", defaults: [`${MOD}+Shift+KeyL`] },
  { id: "viewChips", label: "Chips view", group: "View", defaults: [`${MOD}+Shift+KeyC`] },
  { id: "viewGrid", label: "Icon view", group: "View", defaults: [`${MOD}+Shift+KeyI`] },
  { id: "toggleSingle", label: "Single-pane view", short: "Single pane", group: "View", defaults: [`${MOD}+KeyP`] },
  { id: "zoomIn", label: "Zoom in", group: "View", defaults: [`${MOD}+Equal`, `${MOD}+NumpadAdd`] },
  { id: "zoomOut", label: "Zoom out", group: "View", defaults: [`${MOD}+Minus`, `${MOD}+NumpadSubtract`] },
  { id: "zoomReset", label: "Reset zoom", group: "View", defaults: [`${MOD}+Digit0`, `${MOD}+Numpad0`] },
  { id: "toggleHidden", label: "Toggle hidden files", short: "Hidden", group: "View", defaults: [`${MOD}+Shift+Period`] },
  { id: "keyboardMap", label: "Keyboard map", short: "Keys", group: "View", defaults: [`${MOD}+KeyK`] },
  // Space previews everywhere; the secondary key is F3 ("view") on Windows/Linux,
  // the number row (⌘-free "3") on macOS — matching the file-op key scheme above.
  { id: "preview", label: "Preview", group: "View", defaults: isMac ? ["Space", "Digit3"] : ["Space", "F3"] },
  { id: "closePreview", label: "Close preview", group: "View", defaults: ["Escape"] },
  { id: "devtools", label: "Developer tools", short: "Dev tools", group: "View", defaults: [`${MOD}+Alt+KeyI`] },

  // Favorites
  { id: "favoritesLeft", label: "Favorites — left pane", short: "Favorites L", group: "Favorites", defaults: [`${MOD}+Digit1`] },
  { id: "favoritesRight", label: "Favorites — right pane", short: "Favorites R", group: "Favorites", defaults: [`${MOD}+Digit2`] },

  { id: "resetLayout", label: "Reset pane layout", short: "Reset panes", group: "View", defaults: [] },

  // Web build only. On the desktop the files are already on this machine, so
  // "download" means nothing and getting files in is a drag from Finder.
  // Shift-modified so they clear Chrome's own Ctrl+S / Ctrl+U.
  ...(isWeb
    ? ([
        { id: "downloadItems", label: "Download selection", short: "Download", group: "Files", defaults: [`${MOD}+Shift+KeyS`] },
        { id: "uploadFiles", label: "Upload files here", short: "Upload", group: "Files", defaults: [`${MOD}+Shift+KeyU`] },
      ] as Command[])
    : []),

  // Drives (Windows/Linux only — a single root on macOS makes a drive picker
  // meaningless, so these commands aren't registered there). Alt+F1/F2 open a
  // drive-letter dropdown for the left/right pane, à la Total Commander.
  ...(isMac
    ? []
    : ([
        { id: "drivesLeft", label: "Drives — left pane", short: "Drives L", group: "Panes & navigation", defaults: ["Alt+F1"] },
        { id: "drivesRight", label: "Drives — right pane", short: "Drives R", group: "Panes & navigation", defaults: ["Alt+F2"] },
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
// Named (non-printable) keys whose `key` value is spelled like a `code`, so one
// can stand in for the other.
const NAMED_KEY = /^(Arrow(Up|Down|Left|Right)|F\d{1,2}|Insert|Delete|Home|End|PageUp|PageDown|Backspace|Enter|Escape|Tab)$/;

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // Physical key by default (layout-independent for letters), but a named key
  // the OS produced wins over the key cap it came from: a laptop's Fn+Backspace
  // that the keyboard driver turns into Insert arrives as key "Insert" with
  // code "Backspace", and must not go up a folder. Same for a NumLock-off
  // numpad arrow (code "Numpad8", key "ArrowUp").
  parts.push(NAMED_KEY.test(e.key) ? e.key : e.code);
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
      // COPY, don't alias: the adopt/migrate steps below push into these arrays,
      // and mutating the caller's object is a nasty surprise (it silently
      // corrupted a test that merged the same config twice).
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) base[c.id] = [...(v as string[])];
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
    // The three views moved onto one ⌘⇧ shape (⌘⇧L / ⌘⇧C / ⌘⇧I), which hands
    // the unshifted ⌘C back to sort-by-created and frees ⌘I for Get Info.
    // Saved configs store the FULL binding set, so without this rotation an
    // existing config keeps Chips on ⌘C and Icons on ⌘I — and the new Get Info
    // command would answer a combo already spoken for. Each move is guarded on
    // the binding still being the untouched old default, and every guard reads
    // the OLD value, so the three are independent of each other's order.
    if (base.viewChips.length === 1 && base.viewChips[0] === `${MOD}+KeyC`) {
      base.viewChips = [`${MOD}+Shift+KeyC`];
    }
    if (base.viewGrid.length === 1 && base.viewGrid[0] === `${MOD}+KeyI`) {
      base.viewGrid = [`${MOD}+Shift+KeyI`];
    }
    // Created has now been on both spellings — ⌘C originally, ⌘⇧C for as long
    // as Chips held ⌘C, and ⌘C again now — so accept either and land on ⌘C.
    if (
      base.sortCreated.length === 1 &&
      (base.sortCreated[0] === `${MOD}+Shift+KeyC` || base.sortCreated[0] === `${MOD}+KeyC`)
    ) {
      base.sortCreated = [`${MOD}+KeyC`];
    }
    // ⌘L used to be List view and is now "focus the path bar" (the browser
    // convention). A saved config still holds the old ⌘L, which would leave two
    // commands answering one combo — move List to ⌘⇧L so ⌘L is free for
    // focusPath, whose default then applies (it's absent from older configs).
    if (base.viewList.length === 1 && base.viewList[0] === `${MOD}+KeyL`) {
      base.viewList = [`${MOD}+Shift+KeyL`];
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
      // Windows' Ctrl+F4; on macOS this is the ⌘W it already has, so it's a no-op.
      ["closeTab", isMac ? `${MOD}+KeyW` : "Ctrl+F4"],
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
