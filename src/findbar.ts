// Quick-search bar for a directory pane (⌘F / Ctrl+F): type and the cursor jumps
// to the matching file as you go, like Buffers' find panel. It doesn't filter the
// list — the pane keeps showing everything, the cursor just lands on the match,
// so you can Escape out and carry on from there.
//
// Pure view + key handling. The pane supplies the actual matching through
// FindHost, so this module knows nothing about entries, sorting or archives.

export interface FindHost {
  /** View indices of every entry matching `q`, in display order. */
  matches(q: string): number[];
  /** Where the pane's cursor is right now. */
  cursor(): number;
  /** Move the cursor there and scroll it into view. */
  jump(i: number): void;
  /** The bar has removed itself — drop the reference. */
  onClose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export class FindBar {
  readonly el = el("div", "findbar");
  private input = el("input", "findbar-input");
  private countEl = el("span", "findbar-count");
  private closed = false;
  /** Where the search is anchored. Typing searches forward from here so results
      stay stable as the query grows; stepping through matches moves it along. */
  private anchor: number;

  constructor(private host: FindHost) {
    this.anchor = host.cursor();

    this.input.type = "text";
    this.input.placeholder = "Find file…";
    this.input.spellcheck = false;
    this.input.setAttribute("autocomplete", "off");

    const prev = el("button", "findbar-btn");
    prev.innerHTML = "&#8593;";
    prev.title = "Previous match (⇧⏎)";
    prev.addEventListener("click", () => this.step(-1));
    const next = el("button", "findbar-btn");
    next.innerHTML = "&#8595;";
    next.title = "Next match (⏎)";
    next.addEventListener("click", () => this.step(1));
    const close = el("button", "findbar-btn");
    close.textContent = "✕";
    close.title = "Close (Esc)";
    close.addEventListener("click", () => this.close());

    this.el.append(this.input, this.countEl, prev, next, close);

    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (e) => {
      // Bare keys inside a text field never reach the global shortcut handler,
      // so the list can't move underneath while typing — these are ours.
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.step(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.step(-1);
      } else if (e.key === "Tab") {
        // Tab is "switch pane", but a bare key inside a text field never reaches
        // the global handler — it would just walk focus onto our own buttons.
        // Close instead, which hands the keyboard back to the file list.
        e.preventDefault();
        this.close();
      }
    });

    this.render(0, 0);
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** Re-run the search from the anchor — the incremental "as you type" jump. */
  private search(): void {
    const q = this.input.value;
    const m = this.host.matches(q);
    if (!q.trim()) {
      this.input.classList.remove("bad");
      this.render(0, 0);
      return;
    }
    this.input.classList.toggle("bad", m.length === 0);
    if (!m.length) {
      this.render(0, 0);
      return;
    }
    // First match at or after the anchor, wrapping to the top.
    const i = m.find((x) => x >= this.anchor) ?? m[0];
    this.host.jump(i);
    this.render(m.indexOf(i) + 1, m.length);
  }

  /** Enter / ⇧Enter / arrows: walk to the next or previous match, wrapping. */
  private step(dir: 1 | -1): void {
    const m = this.host.matches(this.input.value);
    if (!m.length) return;
    const cur = this.host.cursor();
    const i =
      dir > 0
        ? (m.find((x) => x > cur) ?? m[0])
        : ([...m].reverse().find((x) => x < cur) ?? m[m.length - 1]);
    this.anchor = i; // keep typing from where we walked to
    this.host.jump(i);
    this.render(m.indexOf(i) + 1, m.length);
    this.input.focus();
  }

  private render(pos: number, total: number): void {
    this.countEl.textContent = total ? `${pos} of ${total}` : this.input.value.trim() ? "no matches" : "";
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.el.remove();
    this.host.onClose();
  }
}
