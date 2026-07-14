import { invoke, isTauri } from "./ipc";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { ChildEntry, ColKey, ColWidths, Details, Entry, Listing, Location, PaneState, SortDir, SortKey, ViewMode } from "./types";
import { clamp, fmtDate, humanSize, recency } from "./format";
import { fileIcon, icons } from "./icons";
import { CodePreview, langForTextFile } from "./codepreview";
import type { LangId } from "./langs";
import {
  cachedDetails,
  cachedIcon,
  cachedIconForPath,
  cachedThumbnail,
  fetchDetails,
  fetchIcon,
  fetchIconForPath,
  fetchThumbnail,
} from "./sysicons";
import { GRID_MAX, GRID_MIN, recordVisit, state } from "./state";

const UP_ENTRY: Entry = {
  name: "..",
  stem: "..",
  ext: null,
  isDir: true,
  isSymlink: false,
  size: 0,
  modifiedMs: null,
  createdMs: null,
  permissions: null,
  hidden: false,
};

const ROW_REM = 1.75;
const OVERSCAN = 8;

/** Doc text for the code preview, appending a note when the read was truncated. */
function codePreviewText(res: { text: string; truncated: boolean }): string {
  return res.truncated ? res.text.replace(/\n?$/, "\n\n… (file truncated for preview)\n") : res.text;
}
// Grid tile chrome (px, independent of zoom — the size slider controls scale).
const TILE_GUTTER = 30; // horizontal breathing room per tile
const TILE_LABEL = 42; // icon-to-baseline + two lines of name

/** One visible row: an entry plus where it sits in the disclosure tree. */
interface ViewRow {
  entry: Entry;
  depth: number;
  /** Absolute path of the directory this entry lives in. */
  dirPath: string;
  /** Stable identity for cursor/expansion bookkeeping (not a filesystem path). */
  key: string;
  open: boolean;
}

interface ExpandState {
  open: boolean;
  listing: Listing;
}

export interface PaneHost {
  activate(p: PaneView): void;
  /** Something persistable changed (path, sort, view) — update tabs, save. */
  changed(): void;
  /** The cursor moved (arrows/click) — used to follow with an opposite-pane preview. */
  cursorMoved(): void;
  /** This pane's sort changed — mirror it to the sibling when linked-sort is on. */
  sortChanged(key: SortKey, dir: SortDir): void;
  /** Column order changed — refresh columns across panes (shared order). */
  columnsChanged(): void;
  showHidden(): boolean;
  sysIcons(): boolean;
  locations(): Location[];
  addLocation(path: string, name: string): void;
  removeLocation(path: string): void;
  /** Reorder the global favorites list (drag-to-reorder in the dropdown). */
  moveLocation(from: number, to: number): void;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class PaneView {
  readonly st: PaneState;
  readonly el: HTMLElement;
  private host: PaneHost;
  private pathInput: HTMLInputElement;
  private errBox: HTMLElement;
  private header: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private rowLayer: HTMLElement;
  private previewEl: HTMLElement;
  private statusText: HTMLElement;
  private sizeSlider: HTMLInputElement;
  private viewSeg: HTMLElement;
  private viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private locBtn: HTMLButtonElement;
  private locPop: HTMLElement | null = null;
  /** Keyboard-highlighted favorite in the open dropdown. */
  private locActive = 0;
  private headCells = new Map<SortKey, HTMLElement>();
  private view: ViewRow[] = [];
  private lastClick = { i: -1, t: 0 };
  /** Selected view indices (the cursor is normally one of them). */
  private selection = new Set<number>();
  /** Fixed end for range selection (⇧-click / ⇧-arrow). */
  private anchor = 0;
  /** A plain click on an already-multiselected row defers collapsing to a
      single selection until mouseup, so a drag can carry the whole set. */
  private pendingSingle: number | null = null;
  /** Item/hidden counts from the last rebuild (for the status line). */
  private itemCount = 0;
  private hiddenCount = 0;
  /** Finder-style disclosure state, keyed by dirPath+name. Session-only. */
  private expandState = new Map<string, ExpandState>();
  /** Chips view: debounce detail/thumbnail fetches + track the active item. */
  private chipTimer = 0;
  private chipKey = "";
  /** Opposite-pane preview: debounce the thumbnail fetch + track the shown item. */
  private previewTimer = 0;
  private previewKey = "";
  /** Read-only CodeMirror view for text-file previews (lazily created, reused). */
  private codePreview: CodePreview | null = null;
  /** Whether the currently-shown preview is the code preview (vs a thumbnail). */
  private codePreviewActive = false;
  /** Largest file size in the current view (for size data bars). */
  private maxSize = 0;

  constructor(st: PaneState, host: PaneHost) {
    this.st = st;
    this.host = host;

    this.el = div("pane");

    // ---- path bar: input + view toggle + locations dropdown ----
    const bar = div("pathbar");
    this.pathInput = document.createElement("input");
    this.pathInput.className = "pathinput";
    this.pathInput.spellcheck = false;
    this.pathInput.autocomplete = "off";

    this.viewSeg = div("viewseg");
    const modes: [ViewMode, string, string][] = [
      ["list", icons.viewList, "List view"],
      ["chips", icons.viewChips, "Chips view"],
      ["grid", icons.viewGrid, "Icon view"],
    ];
    for (const [mode, ic, title] of modes) {
      const b = document.createElement("button");
      b.className = "segbtn";
      b.innerHTML = ic;
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setViewMode(mode);
      });
      this.viewBtns.set(mode, b);
      this.viewSeg.append(b);
    }

    this.locBtn = document.createElement("button");
    this.locBtn.className = "pbtn";
    this.locBtn.innerHTML = icons.bookmarks;
    this.locBtn.title = "Locations";
    this.locBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleLocations();
    });

    bar.append(this.pathInput, this.viewSeg, this.locBtn);

    this.errBox = div("pane-error hidden");

    // ---- list header (columns depend on settings; rebuilt via buildHeader) ----
    this.header = div("listhead");
    this.buildHeader();

    // ---- scroll area ----
    this.scroller = div("rows");
    this.spacer = div("vspacer");
    this.rowLayer = div("rowlayer");
    this.scroller.append(this.spacer, this.rowLayer);
    this.scroller.addEventListener("scroll", () => this.renderRows());
    new ResizeObserver(() => this.renderRows()).observe(this.scroller);

    // ---- status bar: item count + (grid) size slider ----
    const status = div("panestatus");
    this.statusText = document.createElement("span");
    this.sizeSlider = document.createElement("input");
    this.sizeSlider.type = "range";
    this.sizeSlider.className = "gridsize";
    this.sizeSlider.min = String(GRID_MIN);
    this.sizeSlider.max = String(GRID_MAX);
    this.sizeSlider.value = String(this.st.gridSize);
    this.sizeSlider.title = "Icon size";
    this.sizeSlider.addEventListener("input", () => {
      this.st.gridSize = Number(this.sizeSlider.value);
      this.renderGrid();
      this.host.changed();
    });
    this.sizeSlider.addEventListener("mousedown", (e) => e.stopPropagation());
    status.append(this.statusText, this.sizeSlider);

    // Opposite-pane preview overlay: replaces the list/status while showing (the
    // pathbar stays). Hidden by default; App drives show/hidePreview().
    this.previewEl = div("panepreview hidden");

    this.el.append(bar, this.errBox, this.header, this.scroller, this.previewEl, status);
    this.el.addEventListener("mousedown", (e) => {
      // Clicks inside the read-only code preview drive the editor (select / scroll
      // / find) — don't let them bubble up to dismiss the preview.
      if ((e.target as HTMLElement | null)?.closest(".cmprev")) return;
      this.host.activate(this);
    });
    // Keyboard navigation suppresses the mouse-hover highlight (it's confusing to
    // see two highlighted rows — the cursor and whatever the idle pointer sits on).
    // The next real pointer move re-enables hover. Guard on coordinates: a
    // keyboard jump that scrolls the list changes the element under a *stationary*
    // pointer, which makes WebKit fire a synthetic mousemove with UNCHANGED
    // coordinates — ignore those, or the just-scrolled-to row would light up.
    let lastPX = -1;
    let lastPY = -1;
    this.el.addEventListener("mousemove", (e) => {
      if (e.clientX === lastPX && e.clientY === lastPY) return;
      lastPX = e.clientX;
      lastPY = e.clientY;
      this.el.classList.remove("kb-nav");
    });

    this.pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = this.pathInput.value.trim();
        if (v) this.navigate(v).then((ok) => ok && this.pathInput.blur());
      } else if (e.key === "Escape") {
        this.resetPathInput();
        this.pathInput.blur();
      }
    });
    this.pathInput.addEventListener("blur", () => this.resetPathInput());

    // Manual double-click detection (native dblclick is unreliable over
    // virtualized DOM). Works for both list rows and grid tiles.
    this.rowLayer.addEventListener("mousedown", (e) => this.onItemMouseDown(e));
    // Resolve a deferred "collapse to single" if the press was a plain click
    // (a drag clears pendingSingle in dragstart before this fires).
    window.addEventListener("mouseup", (e) => {
      if (this.pendingSingle != null && e.button === 0) {
        this.selectSingle(this.pendingSingle);
        this.pendingSingle = null;
      }
    });
    // No context menu yet — keep ⌃-click free for toggle-selection.
    this.rowLayer.addEventListener("contextmenu", (e) => e.preventDefault());
    // Drag selected items out to Finder / other apps (native drag session).
    this.rowLayer.addEventListener("dragstart", (e) => this.onDragStart(e));
    // Icon view: drag across empty space to rubber-band select (Finder-style).
    this.scroller.addEventListener("mousedown", (e) => this.onMarqueeMouseDown(e));

    this.applyViewMode();
    this.startWatch();
  }

  // ---- auto-refresh: re-list when the current folder changes on disk ----------
  private watchTimer = 0;
  private watchPath = "";
  private watchMtime: number | null = null;

  /** Poll the current directory's mtime; re-list (preserving cursor/selection/
      scroll) when it changes — e.g. a file is added while we're viewing it. */
  private startWatch(): void {
    if (!isTauri) return;
    this.watchTimer = window.setInterval(() => void this.checkDirChanged(), 1500);
    // Refocusing the app is the common "I did something elsewhere" moment —
    // check immediately rather than waiting for the next poll tick.
    window.addEventListener("focus", () => void this.checkDirChanged());
  }

  private async checkDirChanged(): Promise<void> {
    const path = this.st.path;
    if (!path) return;
    // Don't reload out from under an active interaction.
    if (document.activeElement === this.pathInput) return;
    const m = await invoke<number | null>("dir_mtime", { path }).catch(() => null);
    if (path !== this.watchPath) {
      // Directory changed (navigation) — adopt its mtime without reloading.
      this.watchPath = path;
      this.watchMtime = m;
      return;
    }
    if (m != null && this.watchMtime != null && m !== this.watchMtime) {
      this.watchMtime = m;
      void this.softReload();
    } else {
      this.watchMtime = m;
    }
  }

  /** Re-fetch the current directory and rebuild, keeping cursor, selection and
      scroll position (unlike navigate, which resets them). */
  async softReload(): Promise<void> {
    if (!this.st.path) return;
    try {
      const scroll = this.scroller.scrollTop;
      const l = await invoke<Listing>("list_dir", { path: this.st.path, child: null });
      this.st.listing = l;
      this.rebuild(true);
      this.scroller.scrollTop = scroll;
      this.host.changed();
    } catch {
      // dir vanished / unreadable — leave the pane as-is
    }
  }

  private isGrid(): boolean {
    return this.st.viewMode === "grid";
  }

  private isChips(): boolean {
    return this.st.viewMode === "chips";
  }

  private itemIndex(e: MouseEvent): number {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".row, .tile, .crow, .chip");
    return el ? Number(el.dataset.i) : -1;
  }

  /** Mouse selection: ⇧ extends a range, ⌘/⌃ toggles one, plain selects one
      (double-click opens; a plain click on a multi-selection defers to mouseup
      so a drag-out can carry the whole set). */
  private onItemMouseDown(e: MouseEvent): void {
    const i = this.itemIndex(e);
    if (i < 0 || e.button !== 0) return;
    // Disclosure triangle (list only) toggles the subtree, selection untouched.
    if ((e.target as HTMLElement).closest(".disclose.can")) {
      void this.toggleExpand(i);
      return;
    }
    if (e.shiftKey) {
      this.selectToAnchor(i);
      this.lastClick = { i: -1, t: 0 };
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      this.toggleSelect(i);
      this.lastClick = { i: -1, t: 0 };
      return;
    }
    const now = performance.now();
    if (i === this.lastClick.i && now - this.lastClick.t < 400) {
      this.lastClick = { i: -1, t: 0 };
      this.selectSingle(i);
      this.openIndex(i);
      return;
    }
    this.lastClick = { i, t: now };
    if (this.selection.has(i) && this.selection.size > 1) {
      this.pendingSingle = i; // keep the multi-selection until we know it's a click
    } else {
      this.selectSingle(i);
    }
  }

  /** The column order — one global spec shared by every pane and tab. */
  private colOrderKeys(): ColKey[] {
    return state.columnOrder;
  }

  private colVisible(k: ColKey): boolean {
    if (k === "created") return state.settings.showCreated;
    if (k === "perms") return state.settings.showPermissions;
    return true;
  }

  /** Visible column descriptors in display order. */
  private columns(): { key: ColKey; label: string; cls: string; sort?: SortKey; wp?: keyof ColWidths }[] {
    const defs: Record<ColKey, { label: string; cls: string; sort?: SortKey; wp?: keyof ColWidths }> = {
      name: { label: "Name", cls: "col-name", sort: "name" },
      ext: { label: "Ext", cls: "col-ext", sort: "ext", wp: "ext" },
      size: { label: "Size", cls: "col-size", sort: "size", wp: "size" },
      created: { label: "Created", cls: "col-created", sort: "created", wp: "created" },
      perms: { label: "Perms", cls: "col-perms", wp: "perms" },
      mod: { label: "Modified", cls: "col-mod", sort: "modified", wp: "mod" },
    };
    return this.colOrderKeys()
      .filter((k) => this.colVisible(k))
      .map((k) => ({ key: k, ...defs[k] }));
  }

  /** (Re)build the list header for the current column set. */
  private buildHeader(): void {
    this.header.replaceChildren();
    this.headCells.clear();
    for (const col of this.columns()) {
      const c = div(`headcell ${col.cls}`);
      const lab = document.createElement("span");
      lab.textContent = col.label;
      const mark = document.createElement("span");
      mark.className = "sortmark";
      c.append(lab, mark);
      // Drag the header to reorder columns (threshold distinguishes a sort-click).
      c.addEventListener("mousedown", (e) => this.startColDrag(e, col.key));
      if (col.sort) {
        const key = col.sort;
        c.addEventListener("click", () => {
          if (!this.colDragging) this.cycleSort(key);
        });
        this.headCells.set(key, c);
      } else {
        c.style.cursor = "default";
      }
      if (col.wp) {
        const wp = col.wp;
        const grip = div("colgrip");
        grip.addEventListener("click", (e) => e.stopPropagation());
        grip.addEventListener("mousedown", (e) => this.startColResize(e, wp));
        c.append(grip);
      }
      this.header.append(c);
    }
    this.applyColWidths();
    this.applyGridTemplate();
    this.updateSortMarks();
  }

  private applyGridTemplate(): void {
    const wvar: Record<keyof ColWidths, string> = {
      ext: "--w-ext",
      size: "--w-size",
      created: "--w-created",
      perms: "--w-perms",
      mod: "--w-mod",
    };
    // Name keeps a floor so it never collapses when many columns are shown.
    const parts = this.columns().map((col) => (col.wp ? `var(${wvar[col.wp]})` : "minmax(4.5rem, 1fr)"));
    this.el.style.setProperty("--grid-cols", parts.join(" "));
  }

  /** True while a header is being dragged — suppresses the trailing sort-click. */
  private colDragging = false;

  /** Drag a header cell to reorder columns (a thin line marks the drop slot). */
  private startColDrag(e: MouseEvent, fromKey: ColKey): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".colgrip")) return; // that's a resize
    e.preventDefault();
    const startX = e.clientX;
    let dragging = false;
    let targetIndex = -1;
    const indicator = div("coldrop");
    const cells = () => [...this.header.querySelectorAll<HTMLElement>(".headcell")];

    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4) return;
        dragging = true;
        this.colDragging = true;
        document.body.classList.add("col-dragging");
        this.header.appendChild(indicator);
      }
      const cs = cells();
      let idx = cs.length;
      for (let i = 0; i < cs.length; i++) {
        const r = cs[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          idx = i;
          break;
        }
      }
      targetIndex = idx;
      const headLeft = this.header.getBoundingClientRect().left;
      const x =
        idx < cs.length
          ? cs[idx].getBoundingClientRect().left - headLeft
          : cs[cs.length - 1].getBoundingClientRect().right - headLeft;
      indicator.style.left = `${x}px`;
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-dragging");
      indicator.remove();
      if (dragging) {
        this.commitColReorder(fromKey, targetIndex);
        setTimeout(() => (this.colDragging = false), 0); // after the trailing click
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Move `fromKey` to the visible slot `targetIndex`, then persist + refresh. */
  private commitColReorder(fromKey: ColKey, targetIndex: number): void {
    const vis = this.columns().map((c) => c.key);
    const from = vis.indexOf(fromKey);
    if (from < 0 || targetIndex === from || targetIndex === from + 1) return; // no move
    const newVis = vis.filter((k) => k !== fromKey);
    const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex;
    newVis.splice(insertAt, 0, fromKey);
    // Rebuild the full order, keeping hidden columns pinned to their slots.
    let vi = 0;
    const newFull = this.colOrderKeys().map((k) => (this.colVisible(k) ? newVis[vi++] : k));
    state.columnOrder = newFull; // one global order for all panes/tabs
    this.host.changed();
    this.host.columnsChanged();
  }

  /** Rebuild header + rows when the visible columns change (settings toggle). */
  refreshColumns(): void {
    this.buildHeader();
    this.renderRows();
  }

  private applyColWidths(): void {
    const w = state.columnWidths;
    this.el.style.setProperty("--w-ext", `${w.ext}rem`);
    this.el.style.setProperty("--w-size", `${w.size}rem`);
    this.el.style.setProperty("--w-created", `${w.created}rem`);
    this.el.style.setProperty("--w-perms", `${w.perms}rem`);
    this.el.style.setProperty("--w-mod", `${w.mod}rem`);
  }

  private startColResize(e: MouseEvent, prop: keyof ColWidths): void {
    e.preventDefault();
    e.stopPropagation();
    const min = { ext: 2.25, size: 3.5, created: 4.5, perms: 4.5, mod: 4.5 }[prop];
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const startX = e.clientX;
    const startW = state.columnWidths[prop] * rootPx;
    const move = (ev: MouseEvent) => {
      const w = clamp((startW - (ev.clientX - startX)) / rootPx, min, 20);
      state.columnWidths[prop] = Math.round(w * 100) / 100;
      this.applyColWidths();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      this.host.changed();
      this.host.columnsChanged(); // push the new global width to every other pane
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /** Apply the case transform (Settings → nameCase) to a displayed name/ext. */
  private disp(s: string): string {
    const c = state.settings.nameCase;
    return c === "lower" ? s.toLowerCase() : c === "upper" ? s.toUpperCase() : s;
  }

  /** Set a name label. For a launchable `.app` the ".app" suffix is split into a
      very-pale span so the app reads by its base name. `normal` is the text used
      for every other entry (varies by view — stem in list, full name in grid). */
  private fillName(label: HTMLElement, en: Entry, normal: string): void {
    if (en !== UP_ENTRY && this.isLaunchable(en)) {
      const d = this.disp(en.name);
      label.textContent = d.slice(0, -4); // "Safari"
      const ext = document.createElement("span");
      ext.className = "app-ext";
      ext.textContent = d.slice(-4); // ".app"
      label.append(ext);
    } else {
      label.textContent = normal;
    }
  }

  setActive(on: boolean): void {
    this.el.classList.toggle("is-active", on);
    if (!on) this.closeLocations();
  }

  private resetPathInput(): void {
    this.pathInput.value = this.st.path;
    this.hideError();
  }

  private showError(msg: string): void {
    this.errBox.textContent = msg;
    this.errBox.classList.remove("hidden");
  }

  private hideError(): void {
    this.errBox.classList.add("hidden");
  }

  /** Navigate to `path` (or `path`/`child`). Resolves true on success. */
  async navigate(path: string, child?: string, focusName?: string): Promise<boolean> {
    try {
      const l = await invoke<Listing>("list_dir", { path, child: child ?? null });
      this.st.path = l.path;
      this.st.listing = l;
      this.st.cursor = 0;
      recordVisit(l.path); // remember this folder for the "recent folders" highlight
      this.expandState.clear(); // disclosure state belongs to the old root
      this.pathInput.value = l.path;
      this.hideError();
      this.rebuild();
      this.scroller.scrollTop = 0;
      if (focusName) {
        const j = this.view.findIndex((r) => r.depth === 0 && r.entry.name === focusName);
        if (j > 0) this.setCursor(j);
      }
      this.host.changed();
      return true;
    } catch (e) {
      this.showError(String(e));
      return false;
    }
  }

  goUp(): void {
    const l = this.st.listing;
    if (l?.parent) void this.navigate(l.parent, undefined, l.name);
  }

  openCursor(): void {
    this.openIndex(this.st.cursor);
  }

  /** A macOS `.app` bundle that should launch rather than be entered — only when
      the "Launch apps" setting is on. Off (Explore mode) → treat it as a folder. */
  private isLaunchable(en: Entry): boolean {
    return (
      state.settings.launchApps &&
      en !== UP_ENTRY &&
      en.isDir &&
      en.name.toLowerCase().endsWith(".app")
    );
  }

  private openIndex(i: number): void {
    const row = this.view[i];
    if (!row) return;
    if (row.entry === UP_ENTRY) return this.goUp();
    if (row.entry.isDir && !this.isLaunchable(row.entry)) {
      void this.navigate(row.dirPath, row.entry.name);
      return;
    }
    // Files (and launchable .app bundles): hand off to the OS default handler.
    void invoke("open_path", { dir: row.dirPath, name: row.entry.name }).catch((e) =>
      this.showError(String(e))
    );
  }

  /** Maps a Quick Look panel index back to the row index it previews. */
  private previewRows: number[] = [];
  /** Cursor-sync starts only once the panel settles at the index we opened at,
      so the stale indices it emits while opening don't jump the cursor. */
  private previewArmed = false;
  private previewExpected = -1;

  /** Space: open Quick Look on the cursor item. The panel navigates the whole
      directory; applyPreviewIndex() keeps our cursor in sync as it moves. */
  previewCursor(): void {
    const cur = this.view[this.st.cursor];
    if (!cur || cur.entry === UP_ENTRY) return;
    const items: { dir: string; name: string }[] = [];
    this.previewRows = [];
    this.view.forEach((r, i) => {
      if (r.entry === UP_ENTRY) return;
      items.push({ dir: r.dirPath, name: r.entry.name });
      this.previewRows.push(i);
    });
    const index = Math.max(0, this.previewRows.indexOf(this.st.cursor));
    this.previewArmed = false;
    this.previewExpected = index;
    void invoke("quicklook", { items, index }).catch((e) => this.showError(String(e)));
  }

  /** The Quick Look panel moved to item `j`; follow it with the cursor. */
  applyPreviewIndex(j: number): void {
    if (!this.previewArmed) {
      // Ignore transient indices emitted while the panel opens; arm once it
      // reports the index we opened at (the cursor is already there).
      if (j === this.previewExpected) this.previewArmed = true;
      return;
    }
    const row = this.previewRows[j];
    if (row != null) this.setCursor(row);
  }

  // ---- Finder-style disclosure (list only) -----------------------------------

  private async toggleExpand(i: number): Promise<void> {
    const row = this.view[i];
    if (!row || row.entry === UP_ENTRY || !row.entry.isDir || this.isLaunchable(row.entry)) return;
    const st = this.expandState.get(row.key);
    if (st) {
      st.open = !st.open;
      this.rebuild(true);
      return;
    }
    try {
      const l = await invoke<Listing>("list_dir", { path: row.dirPath, child: row.entry.name });
      this.expandState.set(row.key, { open: true, listing: l });
      this.hideError();
      this.rebuild(true);
    } catch (e) {
      this.showError(String(e));
    }
  }

  /** Right-arrow: grid → next item; list → expand (or step into) a dir. */
  expandCursor(): void {
    this.markKbNav();
    if (this.isChips()) return;
    if (this.isGrid()) {
      this.setCursor(this.st.cursor + 1);
      return;
    }
    const row = this.view[this.st.cursor];
    if (!row || row.entry === UP_ENTRY || !row.entry.isDir || this.isLaunchable(row.entry)) return;
    if (this.expandState.get(row.key)?.open) {
      const next = this.view[this.st.cursor + 1];
      if (next && next.depth > row.depth) this.setCursor(this.st.cursor + 1);
    } else {
      void this.toggleExpand(this.st.cursor);
    }
  }

  /** Left-arrow: grid → previous item; list → collapse (or hop to parent). */
  collapseCursor(): void {
    this.markKbNav();
    if (this.isChips()) return;
    if (this.isGrid()) {
      this.setCursor(this.st.cursor - 1);
      return;
    }
    const row = this.view[this.st.cursor];
    if (!row || row.entry === UP_ENTRY) return;
    if (row.entry.isDir && this.expandState.get(row.key)?.open) {
      void this.toggleExpand(this.st.cursor);
      return;
    }
    if (row.depth > 0) {
      for (let j = this.st.cursor - 1; j >= 0; j--) {
        if (this.view[j].depth < row.depth) {
          this.setCursor(j);
          return;
        }
      }
    }
  }

  /** Full path of a child entry within `dirPath` (root-aware). */
  private folderPath(dirPath: string, name: string): string {
    return dirPath.endsWith("/") ? dirPath + name : `${dirPath}/${name}`;
  }

  /** True if `en` is a folder the user has recently entered (a "blue" folder). */
  private isVisited(en: Entry, dirPath: string): boolean {
    return en.isDir && en !== UP_ENTRY && state.visitedPaths.has(this.folderPath(dirPath, en.name));
  }

  /** ←/→: move the cursor to the previous/next recent ("blue") folder. Returns
      false when there isn't one (so the caller can fall back to expand/collapse). */
  jumpVisited(dir: 1 | -1): boolean {
    for (let i = this.st.cursor + dir; i >= 0 && i < this.view.length; i += dir) {
      const r = this.view[i];
      if (r && this.isVisited(r.entry, r.dirPath)) {
        this.markKbNav();
        this.setCursor(i);
        return true;
      }
    }
    return false;
  }

  // ---- view mode -------------------------------------------------------------

  /** Switch this pane's view mode (list / chips / grid). Used by the toolbar
      segmented control and the ⌘L / ⌘C / ⌘I shortcuts. */
  setView(mode: ViewMode): void {
    this.setViewMode(mode);
  }

  private setViewMode(mode: ViewMode): void {
    if (this.st.viewMode === mode) return;
    this.st.viewMode = mode;
    this.applyViewMode();
    this.rebuild(true);
    this.host.changed();
  }

  /** Re-fit the chip layout (used when the chip-cards setting changes). */
  refreshView(): void {
    this.applyViewMode();
    if (this.st.listing) this.rebuild(true);
  }

  private applyViewMode(): void {
    this.el.classList.toggle("grid", this.isGrid());
    this.el.classList.toggle("chips", this.isChips());
    this.el.classList.toggle("chip-cards", this.isChips() && state.settings.chipCards);
    this.el.classList.toggle("big-chips", this.isChips() && state.settings.bigChips);
    for (const [mode, btn] of this.viewBtns) btn.classList.toggle("on", mode === this.st.viewMode);
  }

  // ---- sorting / view building -----------------------------------------------

  /** Header click / sort shortcut: pick `key`, toggling direction if unchanged. */
  cycleSort(key: SortKey): void {
    if (this.st.sortKey === key) {
      this.st.sortDir = this.st.sortDir === 1 ? -1 : 1;
    } else {
      this.st.sortKey = key;
      this.st.sortDir = 1;
    }
    this.rebuild(true);
    this.host.changed();
    this.host.sortChanged(this.st.sortKey, this.st.sortDir);
  }

  /** Adopt a sort from the sibling pane (linked-sort); no re-broadcast. */
  applySort(key: SortKey, dir: SortDir): void {
    if (this.st.sortKey === key && this.st.sortDir === dir) return;
    this.st.sortKey = key;
    this.st.sortDir = dir;
    if (this.st.listing) this.rebuild(true);
    this.host.changed();
  }

  private cmp(): (a: Entry, b: Entry) => number {
    const k = this.st.sortKey;
    const d = this.st.sortDir;
    const byName = (a: Entry, b: Entry) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return (a, b) => {
      // NC-style: folders grouped above files. Finder-style: sorted inline.
      if (state.settings.foldersOnTop && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let c: number;
      if (k === "name") c = byName(a, b);
      else if (k === "ext")
        c = (a.ext ?? "").localeCompare(b.ext ?? "", undefined, { sensitivity: "base" }) || byName(a, b);
      else if (k === "size") c = a.size - b.size || byName(a, b);
      else if (k === "created") c = (a.createdMs ?? 0) - (b.createdMs ?? 0) || byName(a, b);
      else c = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0) || byName(a, b);
      return c * d;
    };
  }

  /** Re-filter + re-sort the listing into view rows (tree in list, flat in grid). */
  rebuild(keepCursor = false): void {
    const l = this.st.listing;
    if (!l) return;
    const prevKey = keepCursor ? this.view[this.st.cursor]?.key : undefined;
    // Remember the selection by identity so sorting/expanding preserves it (a
    // fresh navigation lands on new keys, so the selection naturally clears).
    const selKeys = new Set<string>();
    for (const i of this.selection) {
      const k = this.view[i]?.key;
      if (k) selKeys.add(k);
    }
    const anchorKey = this.view[this.anchor]?.key;
    const show = this.host.showHidden();
    const cmp = this.cmp();

    const rows: ViewRow[] = [];
    if (this.isGrid() || this.isChips()) {
      // Flat current directory, no disclosure. Chips keeps ".." for going up.
      if (this.isChips() && l.parent)
        rows.push({ entry: UP_ENTRY, depth: 0, dirPath: l.path, key: " up", open: false });
      for (const en of l.entries.filter((e) => show || !e.hidden).sort(cmp)) {
        rows.push({ entry: en, depth: 0, dirPath: l.path, key: `${l.path} ${en.name}`, open: false });
      }
    } else {
      if (l.parent)
        rows.push({ entry: UP_ENTRY, depth: 0, dirPath: l.path, key: " up", open: false });
      const walk = (listing: Listing, depth: number) => {
        for (const en of listing.entries.filter((e) => show || !e.hidden).sort(cmp)) {
          const key = `${listing.path} ${en.name}`;
          const ex = en.isDir ? this.expandState.get(key) : undefined;
          const open = !!ex?.open;
          rows.push({ entry: en, depth, dirPath: listing.path, key, open });
          if (open && ex) walk(ex.listing, depth + 1);
        }
      };
      walk(l, 0);
    }
    this.view = rows;
    this.maxSize = 0;
    for (const r of rows) {
      if (r.entry !== UP_ENTRY && !r.entry.isDir) this.maxSize = Math.max(this.maxSize, r.entry.size);
    }
    // Log mode: decade gridlines are equal-width, one per power of ten. The bar
    // masks them to its own width, so each file shows only its own decades.
    if (state.settings.sizeBars && state.settings.sizeBarLog && this.maxSize > 10) {
      this.el.style.setProperty("--decade", `${100 / Math.log10(Math.max(this.maxSize, 10))}%`);
    }

    if (prevKey != null) {
      const j = this.view.findIndex((r) => r.key === prevKey);
      if (j >= 0) this.st.cursor = j;
    }
    this.st.cursor = clamp(this.st.cursor, 0, Math.max(0, this.view.length - 1));

    // Re-map the selection/anchor onto the new row order.
    this.selection = new Set();
    this.view.forEach((r, i) => {
      if (selKeys.has(r.key)) this.selection.add(i);
    });
    const aj = anchorKey != null ? this.view.findIndex((r) => r.key === anchorKey) : -1;
    this.anchor = aj >= 0 ? aj : this.st.cursor;
    if (this.selection.size === 0 && this.isSelectable(this.st.cursor)) {
      this.selection.add(this.st.cursor);
    }

    this.updateSortMarks();
    this.renderRows();
    this.ensureVisible();

    this.itemCount = l.entries.filter((en) => show || !en.hidden).length;
    this.hiddenCount = l.entries.length - l.entries.filter((en) => !en.hidden).length;
    this.updateStatus();
  }

  /** Status line: item count, hidden count, and any multi-selection tally. */
  private updateStatus(): void {
    const show = this.host.showHidden();
    let selCount = 0;
    for (const i of this.selection) if (this.view[i] && this.view[i].entry !== UP_ENTRY) selCount++;
    this.statusText.textContent =
      `${this.itemCount} item${this.itemCount === 1 ? "" : "s"}` +
      (!show && this.hiddenCount > 0 ? ` · ${this.hiddenCount} hidden` : "") +
      (selCount > 1 ? ` · ${selCount} selected` : "");
  }

  private updateSortMarks(): void {
    for (const [key, cell] of this.headCells) {
      const mark = cell.querySelector<HTMLElement>(".sortmark")!;
      if (key === this.st.sortKey) {
        mark.innerHTML = this.st.sortDir === 1 ? icons.sortAsc : icons.sortDesc;
        cell.classList.add("sorted");
      } else {
        mark.innerHTML = "";
        cell.classList.remove("sorted");
      }
    }
  }

  // ---- rendering -------------------------------------------------------------

  renderRows(): void {
    if (this.isGrid()) this.renderGrid();
    else if (this.isChips()) this.renderChips();
    else this.renderList();
  }

  private remPx(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  private rowH(): number {
    return this.remPx() * ROW_REM;
  }

  private renderList(): void {
    const rh = this.rowH();
    const n = this.view.length;
    this.spacer.style.height = `${n * rh}px`;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const a = Math.max(0, Math.floor(top / rh) - OVERSCAN);
    const b = Math.min(n, Math.ceil((top + vh) / rh) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) frag.append(this.buildRow(i, rh));
    this.finishRender(frag, n);
  }

  // ---- grid geometry ----
  private tileW(): number {
    return this.st.gridSize + TILE_GUTTER;
  }
  private tileH(): number {
    return this.st.gridSize + TILE_LABEL;
  }
  private gridCols(): number {
    return Math.max(1, Math.floor(this.scroller.clientWidth / this.tileW()));
  }

  private renderGrid(): void {
    const tw = this.tileW();
    const th = this.tileH();
    const cols = this.gridCols();
    const n = this.view.length;
    const gridRows = Math.ceil(n / cols);
    this.spacer.style.height = `${gridRows * th}px`;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const firstRow = Math.max(0, Math.floor(top / th) - 2);
    const lastRow = Math.min(gridRows, Math.ceil((top + vh) / th) + 2);
    const frag = document.createDocumentFragment();
    for (let i = firstRow * cols; i < Math.min(n, lastRow * cols); i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      frag.append(this.buildTile(i, c * tw, r * th, tw, th));
    }
    this.finishRender(frag, n);
  }

  // ---- icon-view marquee (rubber-band) selection ----
  private marqueeEl: HTMLElement | null = null;

  /** Grid mode: press-drag on empty space rubber-band selects, like Finder.
      Shift/⌘/⌃ adds to the existing selection; a plain drag replaces it (and a
      plain click on empty space clears it). */
  private onMarqueeMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !this.isGrid()) return;
    if ((e.target as HTMLElement).closest(".tile")) return; // a tile → normal selection path
    const rect = this.scroller.getBoundingClientRect();
    if (e.clientX - rect.left >= this.scroller.clientWidth) return; // on the scrollbar
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(this.selection) : new Set<number>();
    if (!additive && this.selection.size) {
      this.selection = new Set();
      this.renderRows();
      this.updateStatus();
    }
    const sx = e.clientX - rect.left + this.scroller.scrollLeft;
    const sy = e.clientY - rect.top + this.scroller.scrollTop;
    const mq = div("marquee");
    this.scroller.append(mq);
    this.marqueeEl = mq;

    // Latest pointer position (kept up to date so the auto-scroll loop can keep
    // extending the selection while the mouse is held still past the edge).
    let px = e.clientX;
    let py = e.clientY;
    let autoScroll = 0;
    let raf = 0;
    const EDGE = 28; // px band at top/bottom that triggers auto-scroll
    const MAX_SPEED = 26; // px per frame at full tilt

    const paint = () => {
      const cx = clamp(px - rect.left, 0, this.scroller.clientWidth) + this.scroller.scrollLeft;
      const cy = clamp(py - rect.top, 0, this.scroller.clientHeight) + this.scroller.scrollTop;
      const x0 = Math.min(sx, cx),
        y0 = Math.min(sy, cy),
        x1 = Math.max(sx, cx),
        y1 = Math.max(sy, cy);
      mq.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
      this.applyMarquee(base, x0, y0, x1, y1);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (autoScroll === 0) return;
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      const next = clamp(this.scroller.scrollTop + autoScroll, 0, max);
      if (next !== this.scroller.scrollTop) {
        this.scroller.scrollTop = next;
        paint(); // extend the marquee/selection into the newly revealed rows
      }
    };

    const onMove = (ev: MouseEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      // Distance past the top/bottom edge (also fires when the mouse leaves the
      // window entirely — clientY < top or > bottom), scaled to a scroll speed.
      const top = rect.top;
      const bottom = rect.top + this.scroller.clientHeight;
      if (py < top + EDGE) {
        autoScroll = -Math.min(MAX_SPEED, Math.ceil((top + EDGE - py) / 2));
      } else if (py > bottom - EDGE) {
        autoScroll = Math.min(MAX_SPEED, Math.ceil((py - (bottom - EDGE)) / 2));
      } else {
        autoScroll = 0;
      }
      paint();
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      mq.remove();
      this.marqueeEl = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    raf = requestAnimationFrame(tick);
  }

  /** Select every selectable tile whose cell intersects the marquee rectangle
      (in content coordinates), unioned with the pre-drag `base` selection. */
  private applyMarquee(base: Set<number>, x0: number, y0: number, x1: number, y1: number): void {
    const cols = this.gridCols();
    const tw = this.tileW();
    const th = this.tileH();
    const n = this.view.length;
    const c0 = Math.max(0, Math.floor(x0 / tw));
    const c1 = Math.min(cols - 1, Math.floor(x1 / tw));
    const r0 = Math.max(0, Math.floor(y0 / th));
    const r1 = Math.floor(y1 / th);
    const sel = new Set(base);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (i < n && this.isSelectable(i)) sel.add(i);
      }
    }
    this.selection = sel;
    const last = Array.from(sel).pop();
    if (last !== undefined) {
      this.st.cursor = last;
      this.anchor = last;
    }
    this.renderRows();
    this.updateStatus();
  }

  private finishRender(frag: DocumentFragment, n: number): void {
    this.rowLayer.replaceChildren(frag);
    if (n === 0 && this.st.listing) {
      const empty = div("emptymsg");
      empty.textContent = "Nothing to see here";
      this.rowLayer.append(empty);
    }
  }

  // ---- chips geometry ----
  // Every row is a compact row except the expanded one (the cursor), which is a
  // tall chip — unless the cursor is on "..", which always stays a plain row.
  private compactRowH(): number {
    return this.remPx() * (state.settings.chipCards ? 2.6 : ROW_REM);
  }
  /** Row index of the expanded chip, or -1 when nothing is expanded. ".." never
      expands; folders only expand when the "Chips for folders" setting is on
      (otherwise they stay plain list-style rows even in chips view). */
  private expandedIndex(): number {
    const en = this.view[this.st.cursor]?.entry;
    if (!en || en === UP_ENTRY) return -1;
    if (en.isDir && !state.settings.folderChips) return -1;
    return this.st.cursor;
  }
  private chipH(): number {
    // Folders carry an extra peek line, so they need a touch more height.
    const en = this.view[this.st.cursor]?.entry;
    const tall = !!en && en !== UP_ENTRY && en.isDir;
    const base = tall ? 8.5 : 7.25;
    // "Bigger chips" ~2× the height so the content preview is more visible.
    return this.remPx() * (state.settings.bigChips ? base * 2 : base);
  }
  private chipOffset(i: number): number {
    const rh = this.compactRowH();
    const cur = this.expandedIndex();
    if (cur < 0 || i <= cur) return i * rh;
    return cur * rh + this.chipH() + (i - cur - 1) * rh;
  }
  private chipIndexAtY(y: number): number {
    const rh = this.compactRowH();
    const cur = this.expandedIndex();
    if (cur < 0 || y < cur * rh) return Math.floor(y / rh);
    if (y < cur * rh + this.chipH()) return cur;
    return cur + 1 + Math.floor((y - cur * rh - this.chipH()) / rh);
  }

  private renderChips(): void {
    const rh = this.compactRowH();
    const n = this.view.length;
    const exp = this.expandedIndex();
    const extra = exp < 0 ? 0 : this.chipH() - rh;
    this.spacer.style.height = `${n * rh + extra}px`;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const a = clamp(this.chipIndexAtY(top) - OVERSCAN, 0, Math.max(0, n - 1));
    const b = clamp(this.chipIndexAtY(top + vh) + OVERSCAN, 0, n);
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      frag.append(i === exp ? this.buildChip(i, rh) : this.buildChipRow(i, rh));
    }
    this.finishRender(frag, n);
  }

  /** Size data-bar width (%) for an entry, relative to the largest file. */
  private sizeBarPct(en: Entry): number {
    if (!state.settings.sizeBars || en === UP_ENTRY || en.isDir || this.maxSize <= 0) return 0;
    const pct = state.settings.sizeBarLog
      ? (Math.log10(Math.max(en.size, 1)) / Math.log10(Math.max(this.maxSize, 10))) * 100
      : (en.size / this.maxSize) * 100;
    return Math.round(pct * 10) / 10;
  }

  /** Prepend a size data bar to a cell (files only; ticks clip to the bar). */
  private appendSizeBar(cell: HTMLElement, en: Entry): void {
    const pct = this.sizeBarPct(en);
    if (pct <= 0) return; // no bar (or ticks) for folders / "..".
    const fill = div("barfill");
    fill.style.setProperty("--bar", `${pct}%`);
    if (state.settings.sizeBarLog && this.maxSize > 10) fill.classList.add("ticks");
    cell.prepend(fill);
  }

  /** Recency class name for a timestamp: is-today, is-yesterday, or "". */
  private recencyName(ms: number | null): string {
    if (!state.settings.highlightToday) return "";
    const r = recency(ms);
    return r === "justnow"
      ? "is-justnow"
      : r === "today"
        ? "is-today"
        : r === "yesterday"
          ? "is-yesterday"
          : "";
  }

  /** Class suffix (with leading space) for an entry's modified time. */
  private recencyClass(en: Entry): string {
    if (en === UP_ENTRY) return "";
    const n = this.recencyName(en.modifiedMs);
    return n ? ` ${n}` : "";
  }

  /** Class suffix (with leading space) for an arbitrary timestamp. */
  private recencyClassOf(ms: number | null): string {
    const n = this.recencyName(ms);
    return n ? ` ${n}` : "";
  }

  /** Render an entry's icon into `ic`. When `thumbPx > 0` and "Preview icons" is
      on, files get their QuickLook content thumbnail (Finder-style), falling back
      to a system/vector icon when there's no previewable content. `thumbPx = 0`
      (the default) means never fetch a thumbnail — used for tiny nested icons. */
  private iconInto(ic: HTMLElement, en: Entry, dirPath: string, thumbPx = 0): void {
    if (en === UP_ENTRY) {
      ic.innerHTML = icons.up;
      return;
    }
    if (en.isSymlink) ic.innerHTML = icons.symlink;
    else if (this.isLaunchable(en)) {
      // A launchable .app reads as an application, not a folder.
      const ft = fileIcon("app");
      ic.classList.add(`type-${ft.cls}`);
      ic.innerHTML = ft.svg;
    } else if (en.isDir) ic.innerHTML = icons.folder;
    else {
      const ft = fileIcon(en.ext);
      ic.classList.add(`type-${ft.cls}`);
      ic.innerHTML = ft.svg;
    }
    if (thumbPx > 0 && !en.isDir && state.settings.previewIcons) {
      this.applyPreviewIcon(ic, en, dirPath, thumbPx);
    } else if (this.host.sysIcons()) {
      this.applySystemIcon(ic, en, dirPath);
    }
  }

  /** Finder-style content thumbnail for a file, with a system/vector fallback
      when the file has no previewable content (QuickLook returns null). */
  private applyPreviewIcon(ic: HTMLElement, en: Entry, dirPath: string, size: number): void {
    const sysFallback = this.host.sysIcons();
    // `thumb` marks a real content preview (vs a system/vector icon) so list view
    // can draw a Finder-style hairline outline around it.
    const setThumb = (uri: string) => {
      this.setSysImg(ic, uri);
      ic.classList.add("thumb");
    };
    const cached = cachedThumbnail(dirPath, en.name, size);
    if (cached) {
      setThumb(cached);
      return;
    }
    if (cached === null) {
      if (sysFallback) this.applySystemIcon(ic, en, dirPath);
      return;
    }
    void fetchThumbnail(dirPath, en.name, size).then((uri) => {
      if (!ic.isConnected) return;
      if (uri) setThumb(uri);
      else if (sysFallback) this.applySystemIcon(ic, en, dirPath);
    });
  }

  /** Build the ordered column cells for an entry. Shared by list rows AND the
      compact chips rows so both honor the exact same column spec (order, width,
      visibility) — switching views keeps the columns identical. `disclosure`
      draws the tree triangle (list view only; chips are flat). */
  private buildCells(
    en: Entry,
    depth: number,
    open: boolean,
    dirPath: string,
    disclosure: boolean
  ): Partial<Record<ColKey, HTMLElement>> {
    const name = div("cell col-name");
    if (depth > 0) name.style.paddingLeft = `${0.25 + depth}rem`;

    const disc = div("disclose");
    if (disclosure && en !== UP_ENTRY && en.isDir && !this.isLaunchable(en)) {
      disc.classList.add("can");
      if (open) disc.classList.add("open");
      disc.innerHTML = icons.chevron;
      disc.title = open ? "Collapse (←)" : "Expand (→)";
    }

    const ic = div("ficon");
    this.iconInto(ic, en, dirPath, 128);

    const label = document.createElement("span");
    label.className = "fname";
    this.fillName(label, en, en === UP_ENTRY ? en.name : this.disp(en.isDir ? en.name : en.stem));
    name.append(disc, ic, label);

    const ext = div("cell col-ext");
    ext.textContent = en.ext ? this.disp(en.ext) : "";
    const size = div("cell col-size sizecell");
    const sv = document.createElement("span");
    sv.className = "cellval";
    sv.textContent = en === UP_ENTRY ? "" : en.isDir ? "<DIR>" : humanSize(en.size);
    this.appendSizeBar(size, en);
    size.append(sv);
    const mod = div("cell col-mod" + this.recencyClass(en));
    mod.textContent = fmtDate(en.modifiedMs);

    const byKey: Partial<Record<ColKey, HTMLElement>> = { name, ext, size, mod };
    if (state.settings.showCreated) {
      const created = div("cell col-created" + this.recencyClassOf(en.createdMs));
      created.textContent = en === UP_ENTRY ? "" : fmtDate(en.createdMs);
      byKey.created = created;
    }
    if (state.settings.showPermissions) {
      const perms = div("cell col-perms");
      perms.textContent = en.permissions ?? "";
      byKey.perms = perms;
    }
    return byKey;
  }

  /** Append the column cells to a row in the configured display order. */
  private appendCells(row: HTMLElement, byKey: Partial<Record<ColKey, HTMLElement>>): void {
    for (const col of this.columns()) {
      const cell = byKey[col.key];
      if (cell) row.append(cell);
    }
  }

  private buildRow(i: number, rh: number): HTMLElement {
    const { entry: en, depth, open, dirPath } = this.view[i];
    const row = div(
      "row" +
        (en.isDir ? " is-dir" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (this.isLaunchable(en) ? " is-app" : "") +
        (this.isVisited(en, dirPath) ? " visited" : "") +
        (state.settings.stripedRows && i % 2 ? " alt" : "") +
        this.selClass(i)
    );
    row.style.top = `${i * rh}px`;
    row.dataset.i = String(i);
    row.draggable = en !== UP_ENTRY;
    this.appendCells(row, this.buildCells(en, depth, open, dirPath, true));
    return row;
  }

  private buildTile(i: number, x: number, y: number, w: number, h: number): HTMLElement {
    const { entry: en, dirPath } = this.view[i];
    const tile = div(
      "tile" +
        (en.isDir ? " is-dir" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (this.isLaunchable(en) ? " is-app" : "") +
        (this.isVisited(en, dirPath) ? " visited" : "") +
        this.selClass(i)
    );
    tile.dataset.i = String(i);
    tile.draggable = en !== UP_ENTRY;
    tile.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

    const ic = div("ficon gridicon");
    ic.style.cssText = `width:${this.st.gridSize}px;height:${this.st.gridSize}px`;
    this.iconInto(ic, en, dirPath, 256);

    const label = document.createElement("span");
    label.className = "fname";
    this.fillName(label, en, en === UP_ENTRY ? en.name : this.disp(en.name)); // full name (no Ext column in grid)

    tile.append(ic, label);
    return tile;
  }

  // ---- chips: compact row + expanded chip ----

  private buildChipRow(i: number, rh: number): HTMLElement {
    const { entry: en, depth, open, dirPath } = this.view[i];
    const row = div(
      "crow" +
        (en.isDir ? " is-dir" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (this.isLaunchable(en) ? " is-app" : "") +
        (this.isVisited(en, dirPath) ? " visited" : "") +
        (state.settings.stripedRows && i % 2 ? " alt" : "") +
        this.selClass(i) // includes the cursor resting on ".."
    );
    row.dataset.i = String(i);
    row.draggable = en !== UP_ENTRY;
    const gap = state.settings.chipCards ? 3 : 0;
    row.style.top = `${this.chipOffset(i) + gap}px`;
    row.style.height = `${rh - gap * 2}px`;
    // Same columns as the list row (chips are flat, so no disclosure triangle).
    this.appendCells(row, this.buildCells(en, depth, open, dirPath, false));
    return row;
  }

  private kindLabel(ext: string | null): string {
    const map: Record<string, string> = {
      image: "Image",
      video: "Video",
      audio: "Audio",
      archive: "Archive",
      code: "Code",
      doc: "Document",
      pdf: "PDF document",
      exec: "Application",
    };
    const cls = fileIcon(ext).cls;
    return map[cls] ?? (ext ? `${ext.toUpperCase()} file` : "File");
  }

  private buildChip(i: number, rh: number): HTMLElement {
    const { entry: en, dirPath } = this.view[i];
    const chip = div(
      "chip" +
        (en.isDir ? " is-dir" : "") +
        (this.isLaunchable(en) ? " is-app" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (this.isVisited(en, dirPath) ? " visited" : "")
    );
    chip.dataset.i = String(i);
    chip.style.top = `${this.chipOffset(i) + 4}px`;
    chip.style.height = `${this.chipH() - 8}px`;

    const thumb = div("chthumb");
    const body = div("chbody");
    const title = div("chtitle");
    const sub = div("chsub");
    body.append(title, sub);
    chip.append(thumb, body);

    if (en === UP_ENTRY) {
      const ic = div("ficon");
      ic.innerHTML = icons.up;
      thumb.append(ic);
      title.textContent = "..";
      sub.textContent = "Parent folder";
      return chip;
    }

    this.chipKey = `${dirPath} ${en.name}`;
    this.fillName(title, en, this.disp(en.name));

    const ic = div("ficon");
    this.iconInto(ic, en, dirPath);
    thumb.append(ic);

    const kind = document.createElement("span");
    kind.textContent = en.isDir ? "Folder" : this.kindLabel(en.ext);
    sub.append(kind);

    const mk = (label: string, field: string, val: string, cls = "") => {
      const t = div("chtile");
      const l = div("chtile-l");
      l.textContent = label;
      const v = div("chtile-v" + cls);
      v.dataset.field = field;
      v.textContent = val;
      t.append(l, v);
      return t;
    };
    // Permissions: normally pinned to the chip's upper-right corner (CSS absolute);
    // in "Bigger chips" it flows in the body as a right-aligned line under the type.
    // Either way it lives in the body so big mode can stack it.
    if (en.permissions) {
      const perms = div("chperms");
      perms.textContent = en.permissions;
      body.append(perms);
    }

    const tiles = div("chtiles");
    // Same strings (and recency coloring) as the list-view Modified/Created columns.
    const modStr = fmtDate(en.modifiedMs);
    const modTile = mk("Modified", "modified", modStr, this.recencyClass(en));
    // Order: Size · Owner · Created · Modified. In "Bigger chips" the .chtiles grid
    // is 2-wide (styles.css), so these wrap to row 1 = Size·Owner, row 2 = Created·Modified.
    const ownerTile = mk("Owner", "owner", "…");
    const createdTile = mk("Created", "created", "…");
    if (en.isDir) {
      tiles.append(mk("Items", "items", "…"), ownerTile, createdTile, modTile);
    } else {
      const sizeTile = mk("Size", "size", humanSize(en.size));
      sizeTile.classList.add("sizecell");
      this.appendSizeBar(sizeTile, en);
      tiles.append(sizeTile, ownerTile, createdTile, modTile);
    }
    body.append(tiles);
    if (en.isDir) {
      const peek = div("chpeek");
      peek.dataset.field = "peek";
      body.append(peek);
    }

    const cd = cachedDetails(dirPath, en.name);
    if (cd) this.applyChipDetails(chip, en, dirPath, cd);
    if (!en.isDir) {
      const ct = cachedThumbnail(dirPath, en.name, state.settings.previewSize);
      if (ct) this.applyChipThumb(chip, ct);
    }
    this.scheduleChipData(this.chipKey, dirPath, en);
    return chip;
  }

  private scheduleChipData(key: string, dirPath: string, en: Entry): void {
    clearTimeout(this.chipTimer);
    const haveDetails = cachedDetails(dirPath, en.name) !== undefined;
    const haveThumb =
      en.isDir || cachedThumbnail(dirPath, en.name, state.settings.previewSize) !== undefined;
    if (haveDetails && haveThumb) return; // already applied synchronously
    this.chipTimer = window.setTimeout(() => {
      if (this.chipKey !== key) return; // moved on before the debounce fired
      void fetchDetails(dirPath, en.name).then((d) => {
        if (this.chipKey !== key) return;
        const chip = this.rowLayer.querySelector<HTMLElement>(".chip");
        if (chip) this.applyChipDetails(chip, en, dirPath, d);
      });
      if (!en.isDir) {
        void fetchThumbnail(dirPath, en.name, state.settings.previewSize).then((uri) => {
          if (this.chipKey !== key || !uri) return;
          const chip = this.rowLayer.querySelector<HTMLElement>(".chip");
          if (chip) this.applyChipThumb(chip, uri);
        });
      }
    }, 140);
  }

  private applyChipDetails(chip: HTMLElement, en: Entry, dirPath: string, d: Details): void {
    const set = (field: string, val: string) => {
      const el = chip.querySelector<HTMLElement>(`[data-field="${field}"]`);
      if (el) el.textContent = val;
    };
    set("created", fmtDate(d.createdMs));
    // Same recency tint as Modified, based on the created time.
    const createdEl = chip.querySelector<HTMLElement>('[data-field="created"]');
    if (createdEl) {
      createdEl.classList.remove("is-justnow", "is-today", "is-yesterday");
      const n = this.recencyName(d.createdMs);
      if (n) createdEl.classList.add(n);
    }
    set("owner", d.owner ?? "—");
    if (en.isDir) {
      const n = d.dirCount;
      set("items", n != null ? String(n) : "—");
      const sub = chip.querySelector(".chsub");
      if (sub) {
        const k = sub.querySelector("span");
        if (k) k.textContent = n != null ? `Folder · ${n} item${n === 1 ? "" : "s"}` : "Folder";
      }
      const peek = chip.querySelector<HTMLElement>('[data-field="peek"]');
      if (peek) {
        const shown = d.children.slice(0, 4).map((c) => c.name);
        const more = (n ?? d.children.length) - shown.length;
        peek.textContent = shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
      }
      this.applyChipDirGrid(chip, dirPath, d.children);
    } else if (d.appName) {
      this.applyChipOpensWith(chip, d.appName, d.appPath);
    }
  }

  private applyChipOpensWith(chip: HTMLElement, appName: string, appPath: string | null): void {
    const sub = chip.querySelector(".chsub");
    if (!sub) return;
    sub.querySelector(".opens")?.remove();
    const pill = div("opens");
    const ic = div("opensic");
    const label = document.createElement("span");
    label.textContent = `Opens with ${appName}`;
    pill.append(ic, label);
    // Clicking the pill opens the item, same as double-click / Enter.
    pill.title = `Open with ${appName}`;
    pill.addEventListener("mousedown", (e) => e.stopPropagation());
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(chip.dataset.i);
      if (Number.isFinite(idx)) this.openIndex(idx);
    });
    sub.append(pill);
    if (!appPath) return;
    const cached = cachedIconForPath(appPath);
    const put = (uri: string) => {
      const img = new Image();
      img.alt = "";
      img.src = uri;
      ic.replaceChildren(img);
    };
    if (cached) put(cached);
    else void fetchIconForPath(appPath).then((uri) => uri && ic.isConnected && put(uri));
  }

  private applyChipThumb(chip: HTMLElement, uri: string): void {
    const thumb = chip.querySelector(".chthumb");
    if (!thumb) return;
    const img = new Image();
    img.alt = "";
    img.className = "chthumb-img";
    img.src = uri;
    thumb.replaceChildren(img);
  }

  private applyChipDirGrid(chip: HTMLElement, dirPath: string, children: ChildEntry[]): void {
    const thumb = chip.querySelector(".chthumb");
    if (!thumb || children.length === 0) return;
    const grid = div("chthumb-grid");
    for (const c of children.slice(0, 4)) {
      const cell = div("ficon chgrid-ic");
      const synth: Entry = {
        name: c.name,
        stem: c.name,
        ext: c.ext,
        isDir: c.isDir,
        isSymlink: c.isSymlink,
        size: 0,
        modifiedMs: null,
        createdMs: null,
        permissions: null,
        hidden: false,
      };
      this.iconInto(cell, synth, dirPath);
      grid.append(cell);
    }
    thumb.replaceChildren(grid);
  }

  private setSysImg(ic: HTMLElement, uri: string): void {
    const img = document.createElement("img");
    img.alt = "";
    img.src = uri;
    ic.classList.add("sys");
    ic.replaceChildren(img);
  }

  private applySystemIcon(ic: HTMLElement, en: Entry, dirPath: string): void {
    const cached = cachedIcon(en, dirPath, en.name);
    if (cached) {
      this.setSysImg(ic, cached);
      return;
    }
    if (cached === null) return;
    void fetchIcon(en, dirPath, en.name).then((uri) => {
      if (uri && ic.isConnected) this.setSysImg(ic, uri);
    });
  }

  // ---- cursor & selection ----------------------------------------------------

  /** Move the cursor to `i`, collapsing the selection to just that row. */
  setCursor(i: number, ensure = true): void {
    this.selectSingle(i, ensure);
  }

  private clampIndex(i: number): number {
    return clamp(i, 0, Math.max(0, this.view.length - 1));
  }

  /** ".." is a navigation affordance, never a selectable/draggable item. */
  private isSelectable(i: number): boolean {
    const r = this.view[i];
    return !!r && r.entry !== UP_ENTRY;
  }

  /** Highlight class for a row: the real selection, plus the cursor when it
      rests on ".." — which is never in the selection set but should still show
      as focused (arrow-to-it / click-it). */
  private selClass(i: number): string {
    if (this.selection.has(i)) return " is-selected";
    if (i === this.st.cursor && this.view[i]?.entry === UP_ENTRY) return " is-selected";
    return "";
  }

  private selectSingle(i: number, ensure = true): void {
    const c = this.clampIndex(i);
    this.st.cursor = c;
    this.anchor = c;
    this.selection = this.isSelectable(c) ? new Set([c]) : new Set();
    this.commitCursor(ensure);
  }

  /** ⌘/⌃-click: toggle one row; it becomes the cursor and range anchor. */
  private toggleSelect(i: number): void {
    const c = this.clampIndex(i);
    if (this.isSelectable(c)) {
      if (this.selection.has(c)) this.selection.delete(c);
      else this.selection.add(c);
    }
    this.st.cursor = c;
    this.anchor = c;
    this.commitCursor(true);
  }

  /** ⇧-click / ⇧-arrow: select the inclusive range from the anchor to `i`. */
  private selectToAnchor(i: number): void {
    const c = this.clampIndex(i);
    this.selection = this.rangeSet(this.anchor, c);
    this.st.cursor = c;
    this.commitCursor(true);
  }

  private rangeSet(a: number, b: number): Set<number> {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const s = new Set<number>();
    for (let i = lo; i <= hi; i++) if (this.isSelectable(i)) s.add(i);
    return s;
  }

  /** ⇧-Arrow: keep the anchor, move the cursor, and grow/shrink the range. */
  extendCursor(d: number): void {
    this.markKbNav();
    const step = this.isGrid() ? this.gridCols() : 1;
    this.selectToAnchor(this.st.cursor + d * step);
  }

  /** ⌘A: select every real entry (skips ".."). */
  selectAll(): void {
    const s = new Set<number>();
    this.view.forEach((r, i) => {
      if (r.entry !== UP_ENTRY) s.add(i);
    });
    this.selection = s;
    this.commitCursor(false);
  }

  private commitCursor(ensure: boolean): void {
    this.pendingSingle = null; // any deliberate selection change resolves the defer
    this.renderRows();
    if (ensure && this.ensureVisible()) this.renderRows();
    this.updateStatus();
    this.host.cursorMoved();
  }

  /** The selected real entries (skips ".."), for drag-out and future ops. */
  selectedEntries(): { dir: string; name: string; isDir: boolean }[] {
    const out: { dir: string; name: string; isDir: boolean }[] = [];
    for (const i of [...this.selection].sort((a, b) => a - b)) {
      const r = this.view[i];
      if (r && r.entry !== UP_ENTRY) out.push({ dir: r.dirPath, name: r.entry.name, isDir: r.entry.isDir });
    }
    return out;
  }

  // ---- drag out to other apps ------------------------------------------------

  /** Begin a native OS drag of the selected files so they can be dropped into
      Finder or any other app. Read-only: this is a copy, never a move. */
  private onDragStart(e: DragEvent): void {
    const i = this.itemIndex(e);
    const row = i >= 0 ? this.view[i] : undefined;
    if (!row || row.entry === UP_ENTRY) {
      e.preventDefault();
      return;
    }
    // Dragging a row that isn't in the selection selects just it first.
    if (!this.selection.has(i)) this.selectSingle(i);
    this.pendingSingle = null; // this press is a drag, not a click

    const paths = this.selectedEntries().map(({ dir, name }) =>
      (dir.endsWith("/") ? dir : dir + "/") + name
    );
    // The webview's own HTML5 drag would fight the native session — cancel it.
    e.preventDefault();
    if (!isTauri || paths.length === 0) return;
    void startDrag({ item: paths, icon: this.dragImage(paths.length) }).catch(() => {});
  }

  /** A small PNG (data URI) used as the drag cursor image, badged with a count. */
  private dragImage(count: number): string {
    const s = 64;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const x = c.getContext("2d")!;
    // A little stack of pages.
    x.fillStyle = "rgba(0,0,0,0.18)";
    const page = (dx: number, dy: number) => {
      x.save();
      x.translate(dx, dy);
      x.fillStyle = "#ffffff";
      x.strokeStyle = "#c7c7cc";
      x.lineWidth = 1.5;
      roundRect(x, 14, 10, 30, 40, 5);
      x.fill();
      x.stroke();
      x.restore();
    };
    if (count > 1) page(6, 6);
    page(0, 0);
    if (count > 1) {
      x.fillStyle = "#ff3b30";
      x.beginPath();
      x.arc(s - 15, 15, 12, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#ffffff";
      x.font = "bold 15px -apple-system, system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(String(count), s - 15, 16);
    }
    return c.toDataURL("image/png");
  }

  /** The entry under the cursor (with its directory), or null. */
  currentEntry(): { entry: Entry; dirPath: string } | null {
    const r = this.view[this.st.cursor];
    return r ? { entry: r.entry, dirPath: r.dirPath } : null;
  }

  // ---- opposite-pane preview -------------------------------------------------

  isPreviewing(): boolean {
    return !this.previewEl.classList.contains("hidden");
  }

  /** Fill this pane with a live preview of `entry` (driven by the other pane). */
  showPreview(entry: Entry, dirPath: string): void {
    const key = entry === UP_ENTRY ? " up" : `${dirPath} ${entry.name}`;
    this.previewKey = key;
    clearTimeout(this.previewTimer);

    // Known text file → render it read-only in CodeMirror (Buffers look-and-feel)
    // rather than a thumbnail. Only the first N bytes are read (a setting).
    if (entry !== UP_ENTRY && !entry.isDir) {
      const lang = langForTextFile(entry.name);
      if (lang) {
        this.showCodePreview(entry, dirPath, lang, key);
        return;
      }
    }
    this.detachCodePreview();

    const stage = div("pp-stage");
    const info = div("pp-info");
    const nameEl = div("pp-name");
    const metaEl = div("pp-meta");
    info.append(nameEl, metaEl);

    if (entry === UP_ENTRY) {
      const ic = div("ficon pp-icon");
      ic.innerHTML = icons.up;
      stage.append(ic);
      nameEl.textContent = "..";
      metaEl.textContent = "Parent folder";
    } else {
      nameEl.textContent = entry.name;
      const ic = div("ficon pp-icon" + (entry.isDir ? " is-dir" : "") + (entry.isSymlink ? " is-link" : ""));
      this.iconInto(ic, entry, dirPath);
      stage.append(ic);
      const parts = [entry.isDir ? "Folder" : this.kindLabel(entry.ext)];
      if (!entry.isDir) parts.push(humanSize(entry.size));
      const when = fmtDate(entry.modifiedMs);
      if (when) parts.push(when);
      metaEl.textContent = parts.join("  ·  ");

      if (!entry.isDir) {
        // Resolution is a setting (CSS letterboxes to fill the pane regardless).
        const px = state.settings.previewSize;
        const cached = cachedThumbnail(dirPath, entry.name, px);
        if (cached) this.setPreviewImg(stage, cached);
        else {
          this.previewTimer = window.setTimeout(() => {
            void fetchThumbnail(dirPath, entry.name, px).then((uri) => {
              if (this.previewKey !== key) return;
              if (uri) this.setPreviewImg(stage, uri);
              // No thumbnail → if it's actually text, open it in the Buffers
              // (CodeMirror) preview instead of leaving a bare icon.
              else this.tryCodeFallback(entry, dirPath, key);
            });
          }, 120);
        }
      }
    }

    this.previewEl.replaceChildren(stage, info);
    this.previewEl.classList.remove("hidden");
    this.el.classList.add("previewing");
  }

  private setPreviewImg(stage: HTMLElement, uri: string): void {
    const img = new Image();
    img.className = "pp-img";
    img.alt = "";
    img.src = uri;
    stage.replaceChildren(img);
  }

  /** Render a text file read-only in a CodeMirror view (identical to Buffers:
      line numbers, minimap, syntax colors, Sublime selection, find, copy). */
  private showCodePreview(entry: Entry, dirPath: string, lang: LangId, key: string): void {
    const host = div("edhost cmprev");
    if (!this.codePreview) this.codePreview = new CodePreview(host, (f) => this.setCodeFocused(f));
    else host.append(this.codePreview.dom); // reuse the one view; re-parent it
    this.codePreview.setDoc("", lang); // placeholder until the read resolves

    this.previewEl.replaceChildren(host);
    this.previewEl.classList.remove("hidden");
    this.el.classList.add("previewing", "code-preview");
    this.codePreviewActive = true;

    void invoke<{ text: string; truncated: boolean; binary: boolean }>("read_text_file", {
      dir: dirPath,
      name: entry.name,
      maxBytes: state.settings.codePreviewBytes,
    })
      .then((res) => {
        if (this.previewKey !== key || !this.codePreview) return;
        // Binary/undecodable → fall back to the normal thumbnail preview.
        if (res.binary) {
          this.detachCodePreview();
          this.previewKey = ""; // force showPreview to rebuild
          this.showPreview(entry, dirPath);
          return;
        }
        this.codePreview.setDoc(codePreviewText(res), lang);
      })
      .catch((e) => {
        if (this.previewKey !== key || !this.codePreview) return;
        this.codePreview.setDoc(`Could not read file:\n${String(e)}`, "plain");
      });
  }

  /** A file with no thumbnail preview: if it decodes as text, open it in the
      code preview (Buffers); if it's binary, keep the icon stage already shown. */
  private tryCodeFallback(entry: Entry, dirPath: string, key: string): void {
    void invoke<{ text: string; truncated: boolean; binary: boolean }>("read_text_file", {
      dir: dirPath,
      name: entry.name,
      maxBytes: state.settings.codePreviewBytes,
    })
      .then((res) => {
        if (this.previewKey !== key || res.binary) return;
        const host = div("edhost cmprev");
        if (!this.codePreview) this.codePreview = new CodePreview(host, (f) => this.setCodeFocused(f));
        else host.append(this.codePreview.dom);
        this.codePreview.setDoc(codePreviewText(res), langForTextFile(entry.name) ?? "plain");
        this.previewEl.replaceChildren(host);
        this.el.classList.add("code-preview");
        this.codePreviewActive = true;
      })
      .catch(() => {});
  }

  /** Move keyboard focus into the open code preview so arrows walk lines. Returns
      false when there's no code preview showing (caller does its normal thing). */
  focusCodePreview(): boolean {
    if (!this.codePreviewActive || !this.codePreview) return false;
    this.codePreview.focus();
    return true;
  }

  /** Reflect code-preview focus on the tab's dual container so CSS can move the
      active-pane highlight onto the preview pane (and off the file pane). */
  private setCodeFocused(focused: boolean): void {
    this.el.closest(".dual")?.classList.toggle("code-focused", focused);
  }

  /** Remove the code preview's editor from the DOM (kept alive for reuse). */
  private detachCodePreview(): void {
    if (this.codePreview) this.codePreview.dom.remove();
    this.el.classList.remove("code-preview");
    this.codePreviewActive = false;
    this.setCodeFocused(false);
  }

  /** Tear down the preview and restore the normal listing view. */
  hidePreview(): void {
    if (!this.isPreviewing()) return;
    clearTimeout(this.previewTimer);
    this.previewKey = "";
    this.previewEl.classList.add("hidden");
    this.el.classList.remove("previewing", "code-preview");
    this.codePreviewActive = false;
    this.setCodeFocused(false);
    if (this.codePreview) {
      this.codePreview.destroy();
      this.codePreview = null;
    }
    this.previewEl.replaceChildren();
    this.renderRows(); // scroller had zero height while hidden — repopulate
  }

  /** Scrolls the cursor into view; returns true when it had to scroll. */
  private ensureVisible(): boolean {
    const s = this.scroller;
    let y: number, h: number;
    if (this.isGrid()) {
      h = this.tileH();
      y = Math.floor(this.st.cursor / this.gridCols()) * h;
    } else if (this.isChips()) {
      h = this.expandedIndex() === this.st.cursor ? this.chipH() : this.compactRowH();
      y = this.chipOffset(this.st.cursor);
    } else {
      h = this.rowH();
      y = this.st.cursor * h;
    }
    if (y < s.scrollTop) s.scrollTop = y;
    else if (y + h > s.scrollTop + s.clientHeight) s.scrollTop = y + h - s.clientHeight;
    else return false;
    return true;
  }

  /** Flag that the cursor moved by keyboard, so hover highlight stays suppressed
      until the pointer actually moves again (see the mousemove listener). */
  private markKbNav(): void {
    this.el.classList.add("kb-nav");
  }

  /** Up/down: one row in list/chips, one grid-row (± columns) in grid. */
  moveCursor(d: number): void {
    this.markKbNav();
    const step = this.isGrid() ? this.gridCols() : 1;
    this.setCursor(this.st.cursor + d * step);
  }

  movePage(d: 1 | -1): void {
    this.markKbNav();
    const s = this.scroller;
    let per: number;
    if (this.isGrid())
      per = Math.max(1, Math.floor(s.clientHeight / this.tileH()) - 1) * this.gridCols();
    else if (this.isChips())
      per = Math.max(1, Math.floor(s.clientHeight / this.compactRowH()) - 1);
    else per = Math.max(1, Math.floor(s.clientHeight / this.rowH()) - 1);
    this.setCursor(this.st.cursor + d * per);
  }

  moveHome(): void {
    this.markKbNav();
    this.setCursor(0);
  }

  moveEnd(): void {
    this.markKbNav();
    this.setCursor(this.view.length - 1);
  }

  // ---- locations (Favorites) dropdown ---------------------------------------

  /** Open/close this pane's Favorites dropdown (⌘1 / ⌘2, or the toolbar button). */
  openFavorites(): void {
    this.toggleLocations();
  }

  private toggleLocations(): void {
    if (this.locPop) this.closeLocations();
    else {
      this.locActive = 0; // fresh open starts at the top
      this.openLocations();
    }
  }

  private closeLocations(): void {
    this.locPop?.remove();
    this.locPop = null;
    this.locBtn.classList.remove("on");
    document.removeEventListener("mousedown", this.onDocDown, true);
  }

  private onDocDown = (e: MouseEvent) => {
    if (this.locPop && !this.locPop.contains(e.target as Node) && e.target !== this.locBtn) {
      this.closeLocations();
    }
  };

  private openLocations(): void {
    this.host.activate(this);
    const pop = div("locpop");
    const list = div("loclist");
    const sys = this.host.sysIcons();

    this.host.locations().forEach((loc, index) => {
      const item = div("locitem" + (index === this.locActive ? " active" : ""));
      item.dataset.index = String(index);
      item.addEventListener("mouseenter", () => this.setLocActive(index));
      const grip = div("locgrip");
      grip.innerHTML = icons.grip;
      grip.title = "Drag to reorder";
      grip.addEventListener("click", (e) => e.stopPropagation());
      grip.addEventListener("mousedown", (e) => this.startFavDrag(e, item, index));
      const ic = div("ficon locicon");
      if (sys) {
        const c = cachedIconForPath(loc.path);
        if (c) this.setSysImg(ic, c);
        else {
          ic.innerHTML = icons.folder;
          void fetchIconForPath(loc.path).then((uri) => {
            if (uri && ic.isConnected) this.setSysImg(ic, uri);
          });
        }
      } else {
        ic.innerHTML = icons.folder;
      }
      const label = document.createElement("span");
      label.className = "locname";
      label.textContent = loc.name;
      label.title = loc.path;
      const rm = document.createElement("button");
      rm.className = "locrm";
      rm.innerHTML = icons.close;
      rm.title = "Remove";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.host.removeLocation(loc.path);
        this.openLocations(); // rebuild the open popover
      });
      item.append(grip, ic, label, rm);
      item.addEventListener("click", () => {
        this.closeLocations();
        void this.navigate(loc.path);
      });
      list.append(item);
    });

    const add = div("locadd");
    add.innerHTML = `${icons.plus}<span>Add current</span>`;
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = this.st.listing?.name || this.st.path;
      this.host.addLocation(this.st.path, name);
      this.openLocations();
    });

    // Focusable so arrow keys / Enter / Escape drive it (⌘1/⌘2 open + focus).
    pop.tabIndex = -1;
    pop.addEventListener("keydown", (e) => this.onLocKey(e));

    pop.append(list, add);
    // Replace any existing popover (e.g. when rebuilding after add/remove).
    this.locPop?.remove();
    this.el.append(pop);
    this.locPop = pop;
    this.locBtn.classList.add("on");
    pop.focus({ preventScroll: true });
    document.addEventListener("mousedown", this.onDocDown, true);
  }

  /** Move the keyboard highlight to favorite `i` and scroll it into view. */
  private setLocActive(i: number): void {
    if (!this.locPop) return;
    const items = [...this.locPop.querySelectorAll<HTMLElement>(".locitem")];
    if (items.length === 0) return;
    this.locActive = clamp(i, 0, items.length - 1);
    items.forEach((el, j) => el.classList.toggle("active", j === this.locActive));
    items[this.locActive]?.scrollIntoView({ block: "nearest" });
  }

  /** Arrow/Enter/Escape handling while the Favorites dropdown is focused. */
  private onLocKey(e: KeyboardEvent): void {
    const locs = this.host.locations();
    if (locs.length === 0) {
      if (e.key === "Escape") this.closeLocations();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.setLocActive((this.locActive + 1) % locs.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.setLocActive((this.locActive - 1 + locs.length) % locs.length);
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        this.setLocActive(0);
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        this.setLocActive(locs.length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        e.stopPropagation();
        const loc = locs[this.locActive];
        this.closeLocations();
        if (loc) void this.navigate(loc.path);
        break;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.closeLocations();
        break;
    }
  }

  /** Drag a favorite by its grip to reorder the (global) favorites list. */
  private startFavDrag(e: MouseEvent, item: HTMLElement, from: number): void {
    e.preventDefault();
    e.stopPropagation();
    const list = item.parentElement;
    if (!list) return;
    const items = () => [...list.querySelectorAll<HTMLElement>(".locitem")];
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 4) return; // a small move is still a click
        dragging = true;
        item.classList.add("dragging");
        document.body.classList.add("fav-dragging");
      }
      // Slot the dragged item before the first sibling whose midpoint is below
      // the pointer (or at the end when past them all).
      const sibs = items().filter((s) => s !== item);
      let ref: HTMLElement | null = null;
      for (const s of sibs) {
        const r = s.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          ref = s;
          break;
        }
      }
      list.insertBefore(item, ref);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("fav-dragging");
      if (!dragging) return;
      const to = items().indexOf(item);
      if (to >= 0 && to !== from) this.host.moveLocation(from, to);
      this.openLocations(); // rebuild from the new order (clears drag state)
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
}
