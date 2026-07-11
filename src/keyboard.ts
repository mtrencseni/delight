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

    const handled = cfg.run(id);
    if (handled !== false) e.preventDefault();
  });
}
