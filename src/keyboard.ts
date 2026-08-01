import { comboFromEvent, comboHasStrongMod, type CommandId } from "./commands";
import { isMac, MOD } from "./platform";

// Clipboard and history: they belong to the focused text field even though they
// carry a strong modifier. MOD is ⌘ on macOS, Ctrl on Windows/Linux; Ctrl+Y is
// the extra Windows redo.
const CLIPBOARD_EDIT = [
  `${MOD}+KeyC`,
  `${MOD}+KeyX`,
  `${MOD}+KeyV`,
  `${MOD}+KeyA`,
  `${MOD}+KeyZ`,
  `${MOD}+Shift+KeyZ`,
  "Ctrl+KeyY",
];

// Moving the caret. Every one of these collides with a real Delight shortcut —
// ⌘←/⌘→ are collapse/expand, ⌘↑/⌘↓ are jump-to-top/bottom — so without this
// list, typing a path and pressing ⌘← moved the file list instead of jumping to
// the start of the line.
//
// Spelled per platform because the gestures genuinely differ: macOS moves by
// line with ⌘ and by word with ⌥; Windows moves by word with Ctrl and by line
// with bare Home/End, which the guard already lets through for having no strong
// modifier. Each also has a Shift form that extends the selection rather than
// moving, generated below rather than listed twice.
const CARET_MOVE = isMac
  ? [
      "Meta+ArrowLeft",
      "Meta+ArrowRight",
      "Meta+ArrowUp",
      "Meta+ArrowDown",
      "Alt+ArrowLeft",
      "Alt+ArrowRight",
    ]
  : ["Ctrl+ArrowLeft", "Ctrl+ArrowRight", "Ctrl+Home", "Ctrl+End"];

// Deleting by word or line, plus the emacs-style bindings Cocoa honors in every
// macOS text field (⌃A/⌃E to line start/end, ⌃K kill to end, …). No selecting
// forms — Shift doesn't extend a deletion.
const CARET_EDIT = isMac
  ? [
      "Meta+Backspace",
      "Alt+Backspace",
      "Alt+Delete",
      "Ctrl+KeyA",
      "Ctrl+KeyE",
      "Ctrl+KeyB",
      "Ctrl+KeyF",
      "Ctrl+KeyP",
      "Ctrl+KeyN",
      "Ctrl+KeyD",
      "Ctrl+KeyH",
      "Ctrl+KeyK",
    ]
  : ["Ctrl+Backspace", "Ctrl+Delete"];

/** The same combo with Shift added — comboFromEvent orders Shift last. */
function selecting(combo: string): string {
  const cut = combo.lastIndexOf("+");
  return `${combo.slice(0, cut + 1)}Shift+${combo.slice(cut + 1)}`;
}

// While editing a text field, all of these belong to the field — never hijack
// them, whatever they happen to be bound to globally.
const NATIVE_EDIT = new Set([
  ...CLIPBOARD_EDIT,
  ...CARET_MOVE,
  ...CARET_MOVE.map(selecting),
  ...CARET_EDIT,
]);

// When the code preview (a CodeMirror editor) is focused, it owns navigation and
// selection — including the strong-modifier combos (⌘↑/⌘↓ jump to doc top/bottom)
// that would otherwise bypass the text-field guard and move the file pane instead.
const EDITOR_OWNED = new Set<CommandId>([
  "cursorUp",
  "cursorDown",
  "cursorHome",
  "cursorEnd",
  "pageUp",
  "pageDown",
  "selectUp",
  "selectDown",
  "selectAll",
  // ⌘←/⌘→ (expand/collapse the file tree) belong to the editor's line-nav when
  // the code preview is focused.
  "expand",
  "collapse",
  // The code preview ships CodeMirror's searchKeymap — ⌘F there should open the
  // editor's find panel, not the pane's quick-search.
  "find",
]);

export interface KeyboardConfig {
  /** Current combo → command lookup (rebuilt by the app when bindings change). */
  lookup(): Map<string, CommandId>;
  /** Run a command. Return false to let the key event through (no preventDefault). */
  run(id: CommandId): boolean | void;
}

export function initKeyboard(cfg: KeyboardConfig): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const combo = comboFromEvent(e);
    if (!combo) return;
    const id = cfg.lookup().get(combo);
    if (!id) return;

    // In a text field, only fire shortcuts that use a strong modifier — bare
    // keys (arrows, Space, Enter, Escape…) belong to the field, and so do the
    // native editing combos (⌘C/X/V/A/Z).
    if (typing && (!comboHasStrongMod(combo) || NATIVE_EDIT.has(combo))) return;

    // The focused code preview owns navigation/selection keys — let CodeMirror
    // handle them (e.g. ⌘↑/⌘↓ to the top/bottom of the preview) instead of
    // moving the file pane underneath.
    if (EDITOR_OWNED.has(id) && t?.closest?.(".cm-editor")) return;

    const handled = cfg.run(id);
    if (handled !== false) e.preventDefault();
  });
}
