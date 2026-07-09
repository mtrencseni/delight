export interface Actions {
  newTab(): void;
  closeTab(): void;
  nextTab(): void;
  prevTab(): void;
  openSettings(): void;
  zoomStep(d: 1 | -1): void;
  zoomReset(): void;
  toggleHidden(): void;
  /** Returns false when the active tab doesn't do pane switching (settings). */
  switchPane(): boolean;
  cursor(d: number): void;
  cursorPage(d: 1 | -1): void;
  cursorHome(): void;
  cursorEnd(): void;
  open(): void;
  up(): void;
  /** Finder-style disclosure: expand/collapse the cursor row's subtree. */
  expand(): void;
  collapse(): void;
  /** Space: Quick Look preview of the cursor item. */
  preview(): void;
  /** ⌥⌘I: toggle the Web Inspector (no-op unless enabled in settings). */
  devtools(): void;
}

export function initKeyboard(a: Actions): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    // ⌥⌘I toggles the Web Inspector (gated by the setting in the handler).
    if (e.metaKey && e.altKey && !e.ctrlKey && e.code === "KeyI") {
      e.preventDefault();
      a.devtools();
      return;
    }

    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      switch (e.code) {
        case "KeyT":
          if (!e.shiftKey) { e.preventDefault(); a.newTab(); }
          return;
        case "KeyW":
          if (!e.shiftKey) { e.preventDefault(); a.closeTab(); }
          return;
        case "Comma":
          e.preventDefault(); a.openSettings();
          return;
        case "Equal":
        case "NumpadAdd":
          e.preventDefault(); a.zoomStep(1);
          return;
        case "Minus":
        case "NumpadSubtract":
          e.preventDefault(); a.zoomStep(-1);
          return;
        case "Digit0":
        case "Numpad0":
          e.preventDefault(); a.zoomReset();
          return;
        case "Period":
          if (e.shiftKey) { e.preventDefault(); a.toggleHidden(); }
          return;
        case "BracketLeft":
          if (e.shiftKey) { e.preventDefault(); a.prevTab(); }
          return;
        case "BracketRight":
          if (e.shiftKey) { e.preventDefault(); a.nextTab(); }
          return;
      }
      return;
    }

    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      e.shiftKey ? a.prevTab() : a.nextTab();
      return;
    }

    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.shiftKey && !typing) {
      if (a.switchPane()) e.preventDefault();
      return;
    }

    if (typing) return;

    switch (e.key) {
      case "ArrowUp": e.preventDefault(); a.cursor(-1); return;
      case "ArrowDown": e.preventDefault(); a.cursor(1); return;
      case "ArrowRight": e.preventDefault(); a.expand(); return;
      case "ArrowLeft": e.preventDefault(); a.collapse(); return;
      case "PageUp": e.preventDefault(); a.cursorPage(-1); return;
      case "PageDown": e.preventDefault(); a.cursorPage(1); return;
      case "Home": e.preventDefault(); a.cursorHome(); return;
      case "End": e.preventDefault(); a.cursorEnd(); return;
      case "Enter": e.preventDefault(); a.open(); return;
      case "Backspace": e.preventDefault(); a.up(); return;
      case " ": e.preventDefault(); a.preview(); return;
    }
  });
}
