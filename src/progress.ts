// Progress dialog for long file operations (copy / move / delete). It starts
// modal — a dimmed backdrop with a centered card — and can be sent to the
// background, at which point the backdrop drops away and the card shrinks to a
// corner panel so the rest of the app stays usable while the op keeps running.
//
// It's a dumb view: the caller drives it with update() from "op-progress" events
// and calls close() when the backend invoke resolves. Cross-platform — plain DOM.

import { humanSize } from "./format";

/** Payload of the backend "op-progress" event (see ops.rs). */
export interface OpProgress {
  id: string;
  done: number;
  total: number;
  current: string;
  unit: "bytes" | "items";
}

interface ProgressOpts {
  /** Present-tense heading: "Copying", "Moving", "Deleting". */
  title: string;
  /** User asked to stop — the caller should invoke `cancel_op`. */
  onCancel: () => void;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

export class ProgressHandle {
  private overlay = div("op-progress-overlay");
  private card = div("op-progress-card");
  private curEl = div("op-progress-current");
  private bar = div("op-progress-bar");
  private detailEl = div("op-progress-detail");
  private bgBtn = document.createElement("button");
  private bg = false;
  private closed = false;

  constructor(private opts: ProgressOpts) {
    const title = div("op-progress-title");
    title.textContent = opts.title;

    this.curEl.textContent = "Preparing…";

    const track = div("op-progress-track");
    track.append(this.bar);

    const actions = div("op-progress-actions");
    this.bgBtn.className = "op-progress-btn";
    this.bgBtn.textContent = "Run in background";
    this.bgBtn.addEventListener("click", () => this.setBg(!this.bg));
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "op-progress-btn danger";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => opts.onCancel());
    actions.append(this.bgBtn, cancelBtn);

    this.card.append(title, this.curEl, track, this.detailEl, actions);
    this.overlay.append(this.card);
    document.body.append(this.overlay);

    // Swallow keydowns so global shortcuts don't fire under the modal; Esc cancels.
    this.overlay.tabIndex = -1;
    this.overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") opts.onCancel();
    });
    // In the corner state, clicking the card brings it back to the foreground.
    this.card.addEventListener("click", (e) => {
      if (this.bg && e.target instanceof HTMLElement && !e.target.closest("button")) {
        this.setBg(false);
      }
    });
    this.overlay.focus();
  }

  update(p: OpProgress): void {
    if (this.closed) return;
    const frac = p.total > 0 ? Math.min(1, p.done / p.total) : 1;
    const pct = Math.round(frac * 100);
    this.bar.style.width = `${pct}%`;
    this.curEl.textContent = p.current || "…";
    this.curEl.title = p.current;
    const amount =
      p.unit === "bytes"
        ? `${humanSize(p.done)} of ${humanSize(p.total)}`
        : `${p.done} of ${p.total} item${p.total === 1 ? "" : "s"}`;
    this.detailEl.textContent = `${amount} · ${pct}%`;
  }

  /** Toggle between the modal card and the non-modal corner panel. */
  private setBg(on: boolean): void {
    if (this.closed || this.bg === on) return;
    this.bg = on;
    if (on) {
      this.card.classList.add("bg");
      document.body.append(this.card); // detach from the (removed) overlay
      this.overlay.remove();
      this.bgBtn.textContent = "Show";
    } else {
      this.card.classList.remove("bg");
      this.overlay.append(this.card);
      document.body.append(this.overlay);
      this.bgBtn.textContent = "Run in background";
      this.overlay.focus();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.overlay.remove();
    this.card.remove();
  }
}
