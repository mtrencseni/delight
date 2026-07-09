import { invoke } from "./ipc";
import type { ChildEntry, Details, Entry, Listing, Location, PaneState, SortKey, ViewMode } from "./types";
import { clamp, fmtDate, fmtDateCompact, humanSize } from "./format";
import { fileIcon, icons } from "./icons";
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
import { GRID_MAX, GRID_MIN, state } from "./state";

const UP_ENTRY: Entry = {
  name: "..",
  stem: "..",
  ext: null,
  isDir: true,
  isSymlink: false,
  size: 0,
  modifiedMs: null,
  hidden: false,
};

const ROW_REM = 1.75;
const OVERSCAN = 8;
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
  showHidden(): boolean;
  sysIcons(): boolean;
  locations(): Location[];
  addLocation(path: string, name: string): void;
  removeLocation(path: string): void;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
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
  private statusText: HTMLElement;
  private sizeSlider: HTMLInputElement;
  private viewSeg: HTMLElement;
  private viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private locBtn: HTMLButtonElement;
  private locPop: HTMLElement | null = null;
  private headCells = new Map<SortKey, HTMLElement>();
  private view: ViewRow[] = [];
  private lastClick = { i: -1, t: 0 };
  /** Finder-style disclosure state, keyed by dirPath+name. Session-only. */
  private expandState = new Map<string, ExpandState>();
  /** Chips view: debounce detail/thumbnail fetches + track the active item. */
  private chipTimer = 0;
  private chipKey = "";

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

    // ---- list header ----
    this.header = div("listhead");
    const cols: [SortKey, string, string][] = [
      ["name", "Name", "col-name"],
      ["ext", "Ext", "col-ext"],
      ["size", "Size", "col-size"],
      ["modified", "Modified", "col-mod"],
    ];
    for (const [key, label, cls] of cols) {
      const c = div(`headcell ${cls}`);
      const lab = document.createElement("span");
      lab.textContent = label;
      const mark = document.createElement("span");
      mark.className = "sortmark";
      c.append(lab, mark);
      c.addEventListener("click", () => this.setSort(key));
      if (key !== "name") {
        const grip = div("colgrip");
        grip.addEventListener("click", (e) => e.stopPropagation());
        grip.addEventListener("mousedown", (e) => this.startColResize(e, key));
        c.append(grip);
      }
      this.headCells.set(key, c);
      this.header.append(c);
    }
    this.applyColWidths();

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

    this.el.append(bar, this.errBox, this.header, this.scroller, status);
    this.el.addEventListener("mousedown", () => this.host.activate(this));

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
    this.rowLayer.addEventListener("mousedown", (e) => {
      const i = this.itemIndex(e);
      if (i < 0 || e.button !== 0) return;
      // Disclosure triangle (list only) toggles the subtree, cursor untouched.
      if ((e.target as HTMLElement).closest(".disclose.can")) {
        void this.toggleExpand(i);
        return;
      }
      this.setCursor(i);
      const now = performance.now();
      if (i === this.lastClick.i && now - this.lastClick.t < 400) {
        this.lastClick = { i: -1, t: 0 };
        this.openIndex(i);
      } else {
        this.lastClick = { i, t: now };
      }
    });

    this.applyViewMode();
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

  private applyColWidths(): void {
    const w = this.st.colWidths;
    this.el.style.setProperty("--w-ext", `${w.ext}rem`);
    this.el.style.setProperty("--w-size", `${w.size}rem`);
    this.el.style.setProperty("--w-mod", `${w.mod}rem`);
  }

  private startColResize(e: MouseEvent, key: SortKey): void {
    e.preventDefault();
    e.stopPropagation();
    const prop = key === "ext" ? "ext" : key === "size" ? "size" : "mod";
    const min = { ext: 2.25, size: 3.5, mod: 4.5 }[prop];
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const startX = e.clientX;
    const startW = this.st.colWidths[prop] * rootPx;
    const move = (ev: MouseEvent) => {
      const w = clamp((startW - (ev.clientX - startX)) / rootPx, min, 20);
      this.st.colWidths[prop] = Math.round(w * 100) / 100;
      this.applyColWidths();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      this.host.changed();
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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

  private openIndex(i: number): void {
    const row = this.view[i];
    if (!row) return;
    if (row.entry === UP_ENTRY) return this.goUp();
    if (row.entry.isDir) {
      void this.navigate(row.dirPath, row.entry.name);
      return;
    }
    // Files: hand off to the OS default handler (never mutates the file).
    void invoke("open_path", { dir: row.dirPath, name: row.entry.name }).catch((e) =>
      this.showError(String(e))
    );
  }

  /** Maps a Quick Look panel index back to the row index it previews. */
  private previewRows: number[] = [];

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
    void invoke("quicklook", { items, index }).catch((e) => this.showError(String(e)));
  }

  /** The Quick Look panel moved to item `j`; follow it with the cursor. */
  applyPreviewIndex(j: number): void {
    const row = this.previewRows[j];
    if (row != null) this.setCursor(row);
  }

  // ---- Finder-style disclosure (list only) -----------------------------------

  private async toggleExpand(i: number): Promise<void> {
    const row = this.view[i];
    if (!row || row.entry === UP_ENTRY || !row.entry.isDir) return;
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
    if (this.isChips()) return;
    if (this.isGrid()) {
      this.setCursor(this.st.cursor + 1);
      return;
    }
    const row = this.view[this.st.cursor];
    if (!row || row.entry === UP_ENTRY || !row.entry.isDir) return;
    if (this.expandState.get(row.key)?.open) {
      const next = this.view[this.st.cursor + 1];
      if (next && next.depth > row.depth) this.setCursor(this.st.cursor + 1);
    } else {
      void this.toggleExpand(this.st.cursor);
    }
  }

  /** Left-arrow: grid → previous item; list → collapse (or hop to parent). */
  collapseCursor(): void {
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

  // ---- view mode -------------------------------------------------------------

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
    for (const [mode, btn] of this.viewBtns) btn.classList.toggle("on", mode === this.st.viewMode);
  }

  // ---- sorting / view building -----------------------------------------------

  private setSort(key: SortKey): void {
    if (this.st.sortKey === key) {
      this.st.sortDir = this.st.sortDir === 1 ? -1 : 1;
    } else {
      this.st.sortKey = key;
      this.st.sortDir = 1;
    }
    this.rebuild(true);
    this.host.changed();
  }

  private cmp(): (a: Entry, b: Entry) => number {
    const k = this.st.sortKey;
    const d = this.st.sortDir;
    const byName = (a: Entry, b: Entry) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return (a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let c: number;
      if (k === "name") c = byName(a, b);
      else if (k === "ext")
        c = (a.ext ?? "").localeCompare(b.ext ?? "", undefined, { sensitivity: "base" }) || byName(a, b);
      else if (k === "size") c = a.size - b.size || byName(a, b);
      else c = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0) || byName(a, b);
      return c * d;
    };
  }

  /** Re-filter + re-sort the listing into view rows (tree in list, flat in grid). */
  rebuild(keepCursor = false): void {
    const l = this.st.listing;
    if (!l) return;
    const prevKey = keepCursor ? this.view[this.st.cursor]?.key : undefined;
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

    if (prevKey != null) {
      const j = this.view.findIndex((r) => r.key === prevKey);
      if (j >= 0) this.st.cursor = j;
    }
    this.st.cursor = clamp(this.st.cursor, 0, Math.max(0, this.view.length - 1));
    this.updateSortMarks();
    this.renderRows();
    this.ensureVisible();

    const topShown = l.entries.filter((en) => show || !en.hidden).length;
    const hidden = l.entries.length - l.entries.filter((en) => !en.hidden).length;
    this.statusText.textContent =
      `${topShown} item${topShown === 1 ? "" : "s"}` +
      (!show && hidden > 0 ? ` · ${hidden} hidden` : "");
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

  private finishRender(frag: DocumentFragment, n: number): void {
    this.rowLayer.replaceChildren(frag);
    if (n === 0 && this.st.listing) {
      const empty = div("emptymsg");
      empty.textContent = "Nothing to see here";
      this.rowLayer.append(empty);
    }
  }

  // ---- chips geometry ----
  // Every row is a compact row except the cursor row, which is a tall chip.
  private compactRowH(): number {
    return this.remPx() * (state.settings.chipCards ? 2.6 : ROW_REM);
  }
  private chipH(): number {
    // Folders carry an extra peek line, so they need a touch more height.
    const en = this.view[this.st.cursor]?.entry;
    const tall = !!en && en !== UP_ENTRY && en.isDir;
    return this.remPx() * (tall ? 8.5 : 7.25);
  }
  private chipOffset(i: number): number {
    const rh = this.compactRowH();
    const cur = this.st.cursor;
    return i <= cur ? i * rh : cur * rh + this.chipH() + (i - cur - 1) * rh;
  }
  private chipIndexAtY(y: number): number {
    const rh = this.compactRowH();
    const cur = this.st.cursor;
    if (y < cur * rh) return Math.floor(y / rh);
    if (y < cur * rh + this.chipH()) return cur;
    return cur + 1 + Math.floor((y - cur * rh - this.chipH()) / rh);
  }

  private renderChips(): void {
    const rh = this.compactRowH();
    const n = this.view.length;
    this.spacer.style.height = `${n * rh + (this.chipH() - rh)}px`;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const a = clamp(this.chipIndexAtY(top) - OVERSCAN, 0, Math.max(0, n - 1));
    const b = clamp(this.chipIndexAtY(top + vh) + OVERSCAN, 0, n);
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      frag.append(i === this.st.cursor ? this.buildChip(i, rh) : this.buildChipRow(i, rh));
    }
    this.finishRender(frag, n);
  }

  private iconInto(ic: HTMLElement, en: Entry, dirPath: string): void {
    if (en === UP_ENTRY) ic.innerHTML = icons.up;
    else if (en.isSymlink) ic.innerHTML = icons.symlink;
    else if (en.isDir) ic.innerHTML = icons.folder;
    else {
      const ft = fileIcon(en.ext);
      ic.classList.add(`type-${ft.cls}`);
      ic.innerHTML = ft.svg;
    }
    if (en !== UP_ENTRY && this.host.sysIcons()) this.applySystemIcon(ic, en, dirPath);
  }

  private buildRow(i: number, rh: number): HTMLElement {
    const { entry: en, depth, open, dirPath } = this.view[i];
    const row = div(
      "row" +
        (en.isDir ? " is-dir" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (i === this.st.cursor ? " is-cursor" : "")
    );
    row.style.top = `${i * rh}px`;
    row.dataset.i = String(i);

    const name = div("cell col-name");
    if (depth > 0) name.style.paddingLeft = `${0.25 + depth}rem`;

    const disc = div("disclose");
    if (en !== UP_ENTRY && en.isDir) {
      disc.classList.add("can");
      if (open) disc.classList.add("open");
      disc.innerHTML = icons.chevron;
      disc.title = open ? "Collapse (←)" : "Expand (→)";
    }

    const ic = div("ficon");
    this.iconInto(ic, en, dirPath);

    const label = document.createElement("span");
    label.className = "fname";
    label.textContent = en.isDir ? en.name : en.stem;
    name.append(disc, ic, label);

    const ext = div("cell col-ext");
    ext.textContent = en.ext ?? "";
    const size = div("cell col-size");
    size.textContent = en === UP_ENTRY ? "" : en.isDir ? "<DIR>" : humanSize(en.size);
    const mod = div("cell col-mod");
    mod.textContent = fmtDate(en.modifiedMs);

    row.append(name, ext, size, mod);
    return row;
  }

  private buildTile(i: number, x: number, y: number, w: number, h: number): HTMLElement {
    const { entry: en, dirPath } = this.view[i];
    const tile = div(
      "tile" +
        (en.isDir ? " is-dir" : "") +
        (en.isSymlink ? " is-link" : "") +
        (en.hidden ? " is-hidden" : "") +
        (i === this.st.cursor ? " is-cursor" : "")
    );
    tile.dataset.i = String(i);
    tile.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

    const ic = div("ficon gridicon");
    ic.style.cssText = `width:${this.st.gridSize}px;height:${this.st.gridSize}px`;
    this.iconInto(ic, en, dirPath);

    const label = document.createElement("span");
    label.className = "fname";
    label.textContent = en.name; // full name (no Ext column in grid)

    tile.append(ic, label);
    return tile;
  }

  // ---- chips: compact row + expanded chip ----

  private buildChipRow(i: number, rh: number): HTMLElement {
    const { entry: en, dirPath } = this.view[i];
    const row = div(
      "crow" + (en.isDir ? " is-dir" : "") + (en.isSymlink ? " is-link" : "") + (en.hidden ? " is-hidden" : "")
    );
    row.dataset.i = String(i);
    const gap = state.settings.chipCards ? 3 : 0;
    row.style.top = `${this.chipOffset(i) + gap}px`;
    row.style.height = `${rh - gap * 2}px`;
    const ic = div("ficon crowicon");
    this.iconInto(ic, en, dirPath);
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = en.name;
    const size = div("crowmeta");
    size.textContent = en === UP_ENTRY ? "" : en.isDir ? "<DIR>" : humanSize(en.size);
    const mod = div("crowmeta");
    mod.textContent = fmtDate(en.modifiedMs);
    row.append(ic, name, size, mod);
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
      "chip" + (en.isDir ? " is-dir" : "") + (en.isSymlink ? " is-link" : "") + (en.hidden ? " is-hidden" : "")
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
    title.textContent = en.name;

    const ic = div("ficon");
    this.iconInto(ic, en, dirPath);
    thumb.append(ic);

    const kind = document.createElement("span");
    kind.textContent = en.isDir ? "Folder" : this.kindLabel(en.ext);
    sub.append(kind);

    const mk = (label: string, field: string, val: string) => {
      const t = div("chtile");
      const l = div("chtile-l");
      l.textContent = label;
      const v = div("chtile-v");
      v.dataset.field = field;
      v.textContent = val;
      t.append(l, v);
      return t;
    };
    const tiles = div("chtiles");
    const modStr = fmtDateCompact(en.modifiedMs);
    if (en.isDir) {
      tiles.append(mk("Items", "items", "…"), mk("Created", "created", "…"), mk("Modified", "modified", modStr), mk("Owner", "owner", "…"));
    } else {
      tiles.append(mk("Size", "size", humanSize(en.size)), mk("Created", "created", "…"), mk("Modified", "modified", modStr), mk("Owner", "owner", "…"));
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
      const ct = cachedThumbnail(dirPath, en.name);
      if (ct) this.applyChipThumb(chip, ct);
    }
    this.scheduleChipData(this.chipKey, dirPath, en);
    return chip;
  }

  private scheduleChipData(key: string, dirPath: string, en: Entry): void {
    clearTimeout(this.chipTimer);
    const haveDetails = cachedDetails(dirPath, en.name) !== undefined;
    const haveThumb = en.isDir || cachedThumbnail(dirPath, en.name) !== undefined;
    if (haveDetails && haveThumb) return; // already applied synchronously
    this.chipTimer = window.setTimeout(() => {
      if (this.chipKey !== key) return; // moved on before the debounce fired
      void fetchDetails(dirPath, en.name).then((d) => {
        if (this.chipKey !== key) return;
        const chip = this.rowLayer.querySelector<HTMLElement>(".chip");
        if (chip) this.applyChipDetails(chip, en, dirPath, d);
      });
      if (!en.isDir) {
        void fetchThumbnail(dirPath, en.name).then((uri) => {
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
    set("created", fmtDateCompact(d.createdMs));
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

  // ---- cursor ----------------------------------------------------------------

  setCursor(i: number, ensure = true): void {
    this.st.cursor = clamp(i, 0, Math.max(0, this.view.length - 1));
    // Chips: the cursor row changes size (it becomes the chip), so the whole
    // layout shifts — re-render rather than just toggling a class.
    if (this.isChips()) {
      this.renderRows();
      if (ensure && this.ensureVisible()) this.renderRows();
      return;
    }
    this.rowLayer.querySelectorAll(".is-cursor").forEach((r) => r.classList.remove("is-cursor"));
    this.rowLayer.querySelector(`[data-i="${this.st.cursor}"]`)?.classList.add("is-cursor");
    if (ensure && this.ensureVisible()) this.renderRows();
  }

  /** Scrolls the cursor into view; returns true when it had to scroll. */
  private ensureVisible(): boolean {
    const s = this.scroller;
    let y: number, h: number;
    if (this.isGrid()) {
      h = this.tileH();
      y = Math.floor(this.st.cursor / this.gridCols()) * h;
    } else if (this.isChips()) {
      h = this.chipH();
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

  /** Up/down: one row in list/chips, one grid-row (± columns) in grid. */
  moveCursor(d: number): void {
    const step = this.isGrid() ? this.gridCols() : 1;
    this.setCursor(this.st.cursor + d * step);
  }

  movePage(d: 1 | -1): void {
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
    this.setCursor(0);
  }

  moveEnd(): void {
    this.setCursor(this.view.length - 1);
  }

  // ---- locations dropdown ----------------------------------------------------

  private toggleLocations(): void {
    if (this.locPop) this.closeLocations();
    else this.openLocations();
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

    for (const loc of this.host.locations()) {
      const item = div("locitem");
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
      item.append(ic, label, rm);
      item.addEventListener("click", () => {
        this.closeLocations();
        void this.navigate(loc.path);
      });
      list.append(item);
    }

    const add = div("locadd");
    add.innerHTML = `${icons.plus}<span>Add current</span>`;
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = this.st.listing?.name || this.st.path;
      this.host.addLocation(this.st.path, name);
      this.openLocations();
    });

    pop.append(list, add);
    // Replace any existing popover (e.g. when rebuilding after add/remove).
    this.locPop?.remove();
    this.el.append(pop);
    this.locPop = pop;
    this.locBtn.classList.add("on");
    document.addEventListener("mousedown", this.onDocDown, true);
  }
}
