// A read-only CodeMirror 6 view for previewing text files, built from Buffers'
// shared editor internals (editor-core.ts, symlinked in) so it looks and behaves
// exactly like Buffers: line numbers, minimap, Sublime selection, syntax colors,
// find (⌘F) and copy — but no editing. One view per pane; setDoc swaps content.

import { EditorState } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { cursorDocEnd, cursorDocStart, defaultKeymap, selectDocEnd, selectDocStart } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  highlight,
  minimapExtension,
  overlayScrollbar,
  selectionWhitespace,
  sublimeSelection,
} from "./editor-core";
import { LANGS, LANG_IDS, type LangId } from "./langs";

/** Tab / Shift-Tab handler: drop editor focus (back to the file pane's global
    keyboard nav) and consume the key so it can't native-tab into a path bar. */
function blurEditor(view: EditorView): boolean {
  view.contentDOM.blur();
  return true;
}

/** The language to preview `name` as, or null when the extension isn't a known
    text type (so the caller keeps the normal thumbnail/icon preview instead). */
export function langForTextFile(name: string): LangId | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension (or a dotfile like ".gitignore")
  const ext = name.slice(dot + 1).toLowerCase();
  for (const id of LANG_IDS) if (LANGS[id].exts.includes(ext)) return id;
  return null;
}

export class CodePreview {
  readonly view: EditorView;
  private onFocusChange?: (focused: boolean) => void;

  constructor(parent: HTMLElement, onFocusChange?: (focused: boolean) => void) {
    this.onFocusChange = onFocusChange;
    this.view = new EditorView({ parent });
  }

  /** The editor's root element (re-parent it when the preview host is rebuilt). */
  get dom(): HTMLElement {
    return this.view.dom;
  }

  /** Focus the editor so arrow keys move the cursor between lines. */
  focus(): void {
    this.view.focus();
  }

  /** Load `text` as `lang`, read-only. Matches Buffers' default look (soft wrap +
      minimap on, no active-line highlight). */
  setDoc(text: string, lang: LangId): void {
    const syntax = LANGS[lang].syntax();
    this.view.setState(
      EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          highlightSpecialChars(),
          sublimeSelection,
          selectionWhitespace,
          highlightSelectionMatches(),
          minimapExtension(),
          overlayScrollbar,
          EditorView.lineWrapping,
          syntaxHighlighting(highlight),
          search({ top: true }),
          // Report focus/blur so the app can move the "active pane" highlight onto
          // the preview while the editor is focused (Tab in), and back off (Tab out).
          EditorView.updateListener.of((u) => {
            if (u.focusChanged) this.onFocusChange?.(u.view.hasFocus);
          }),
          // Tab must not native-tab focus into the other pane's path bar. Instead
          // blur the editor so keyboard nav resumes on the (already-active) file
          // pane — the user clicks in to read, then Tabs back out to arrow through
          // files. Consume Shift-Tab the same way so it can't escape backwards.
          keymap.of([
            { key: "Tab", shift: blurEditor, run: blurEditor },
            // ⌘↑/⌘↓ jump to the top/bottom of the preview (keyboard.ts lets the
            // focused editor keep these instead of moving the file pane).
            { key: "Mod-ArrowUp", run: cursorDocStart, shift: selectDocStart },
            { key: "Mod-ArrowDown", run: cursorDocEnd, shift: selectDocEnd },
            ...defaultKeymap,
            ...searchKeymap,
          ]),
          syntax ?? [],
        ],
      })
    );
    this.view.scrollDOM.scrollTop = 0;
  }

  destroy(): void {
    this.view.destroy();
  }
}
