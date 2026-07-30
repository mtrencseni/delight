// A read-only CodeMirror 6 view for previewing text files, built from Buffers'
// shared editor internals (editor-core.ts, symlinked in) so it looks and behaves
// exactly like Buffers: line numbers, minimap, Sublime selection, syntax colors,
// find (⌘F) and copy — but no editing. One view per pane; setDoc swaps content.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
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
import { state } from "./state";

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
  private fontComp = new Compartment();

  constructor(parent: HTMLElement, onFocusChange?: (focused: boolean) => void) {
    this.onFocusChange = onFocusChange;
    this.view = new EditorView({ parent });
    this.applyFontVars();
  }

  /** The editor's root element (re-parent it when the preview host is rebuilt). */
  get dom(): HTMLElement {
    return this.view.dom;
  }

  /** Focus the editor so arrow keys move the cursor between lines. */
  focus(): void {
    this.view.focus();
  }

  // ---- preview font size (⌘+/−/0 while the preview is focused) ---------------
  // Sized independently of the app zoom, from state.previewFontSize. Follows
  // Buffers' hard-won recipe: the size lives in CSS vars AND a CM theme in a
  // compartment, because a theme reconfigure is the only trigger that reliably
  // makes CodeMirror re-read styles and refresh its cached line metrics —
  // changing the vars alone leaves the gutter on stale line heights.

  private fontTheme(): Extension {
    const px = state.previewFontSize;
    return EditorView.theme({
      "&": { fontSize: `${px}px` },
      ".cm-scroller": { lineHeight: `${Math.round(px * 1.3)}px` },
    });
  }

  /** Inline vars on the editor root, overriding editor-core.css's :root
      defaults for this view only (both panes' previews get their own call). */
  private applyFontVars(): void {
    const px = state.previewFontSize;
    this.view.dom.style.setProperty("--ed-size", `${px}px`);
    this.view.dom.style.setProperty("--ed-line-height", `${Math.round(px * 1.3)}px`);
  }

  /** The preview font size changed: re-apply vars + theme, then force real
      measures while the new font settles so wrapped-line heights (and with
      them the gutter) can't stay on the old estimates. */
  applyFontSize(): void {
    this.applyFontVars();
    this.view.dispatch({ effects: this.fontComp.reconfigure(this.fontTheme()) });
    requestAnimationFrame(() => this.remeasureVisibleLines());
    for (const ms of [50, 150, 350]) window.setTimeout(() => this.remeasureVisibleLines(), ms);
  }

  /** Measure every visible line's real height (coordsAtPos, called directly —
      inside a requestMeasure read it provably does NOT update the height map). */
  private remeasureVisibleLines(): void {
    const v = this.view;
    if (v.state.doc.length === 0) return;
    const from = v.state.doc.lineAt(v.viewport.from).number;
    const to = v.state.doc.lineAt(v.viewport.to).number;
    for (let ln = from; ln <= to; ln++) {
      const line = v.state.doc.line(ln);
      v.coordsAtPos(line.from);
      if (line.length) v.coordsAtPos(line.to);
    }
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
          this.fontComp.of(this.fontTheme()),
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
