import { comboFromEvent, comboHasStrongMod, type CommandId } from "./commands";

// While editing a text field, these belong to the field (copy/cut/paste/select/
// undo/redo) even though they carry a strong modifier — never hijack them.
const NATIVE_EDIT = new Set([
  "Meta+KeyC",
  "Meta+KeyX",
  "Meta+KeyV",
  "Meta+KeyA",
  "Meta+KeyZ",
  "Meta+Shift+KeyZ",
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
