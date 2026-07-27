// Progress dialog for long file operations (copy / move / delete). It starts
// modal — a dimmed backdrop with a centered card — and can be sent to the
// background, at which point the backdrop drops away and the card shrinks to a
// corner panel so the rest of the app stays usable while the op keeps running.
//
// It's a dumb view: the caller drives it with update() from "op-progress" events
// and calls close() when the backend invoke resolves. Cross-platform — plain DOM.
//
// Fast operations must never flash it. The card is built up front but only put
// in the document after `delayMs` (Settings → "Show progress after"), so an op
// that finishes first never shows anything at all; and once it IS up it stays
// for MIN_VISIBLE_MS, so an op landing just past the threshold doesn't blink.

import { humanSize } from "./format";

/** Once the card is up, keep it up at least this long. Without this the delay
    would only move the flash rather than remove it: an op finishing a few ms
    past the threshold would show the card for a frame or two. */
const MIN_VISIBLE_MS = 400;

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
  /** Hold the dialog back this long before showing it, so quick operations
      complete without ever putting it on screen. 0 shows it immediately. */
  delayMs?: number;
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
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private mounted = false;
  private shownAt = 0;

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
    // NOT added to the document yet — mount() does that, now or after delayMs.

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
    const delay = Math.max(0, opts.delayMs ?? 0);
    if (delay === 0) this.mount();
    else this.showTimer = setTimeout(() => this.mount(), delay);
  }

  /** Put the dialog on screen. Until this runs the app stays fully interactive —
      update() keeps filling in the detached card, so when it does appear it shows
      real progress rather than "Preparing…". */
  private mount(): void {
    if (this.closed || this.mounted) return;
    this.mounted = true;
    this.shownAt = Date.now();
    document.body.append(this.overlay);
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

  /** The op finished (or errored). If the dialog never made it on screen this is
      silent. `immediate` skips the minimum-visible hold — needed when another
      modal is about to be raised, since this one sits above the modal layer and
      would swallow its clicks and keys. */
  close(immediate = false): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.showTimer);
    if (!this.mounted) return; // never shown — nothing to tear down, no flash
    const remaining = MIN_VISIBLE_MS - (Date.now() - this.shownAt);
    if (!immediate && remaining > 0) setTimeout(() => this.remove(), remaining);
    else this.remove();
  }

  private remove(): void {
    this.overlay.remove();
    this.card.remove();
  }
}
