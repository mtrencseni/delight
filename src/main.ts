import "./styles.css";
import { invoke, isTauri, onEvent } from "./ipc";
import { clearVisited, CODE_PREVIEW_BYTES, GRID_DEFAULT, GRID_MAX, GRID_MIN, hint, newTabId, normalizeColumnOrder, persist, PREVIEW_SIZES, rebuildVisitedIndex, state, VISITED_SIZES, ZOOM_LEVELS } from "./state";
import { isMac } from "./platform";
import type { PaneState, SortDir, SortKey, Tab, Theme } from "./types";
import { PaneView } from "./pane";
import { FavSidebar } from "./favsidebar";
import { initKeyboard } from "./keyboard";
import { COMMANDS, mergeKeybindings, type CommandId } from "./commands";
import { applyTheme, effectiveTheme, onThemeChange } from "./theme";
import { toast } from "./toast";
import { confirmDialog, promptDialog } from "./dialog";
import { ProgressHandle, type OpProgress } from "./progress";
import { archiveFileFor, askArchivePassword, inArchive, needsPassword, setArchiveFormats } from "./archive";
import { icons } from "./icons";
import { buildSettingsPage, type SettingsPage } from "./settingsPage";
import { buildKeybindingsPage, type KeybindingsPage } from "./keybindingsPage";
import { baseName, clamp, withSep } from "./format";

/** Result of a copy/move/trash op (see ops.rs `OpResult`). */
interface OpResult {
  done: string[];
  skipped: string[];
  cancelled: boolean;
}

interface TabView {
  el: HTMLElement;
  panes: [PaneView, PaneView] | null;
  dual?: HTMLElement;
  sidebar?: FavSidebar;
  settings?: SettingsPage;
  keybindings?: KeybindingsPage;
  /** Which pane (if any) had an opposite-pane preview open when we last left this
      tab, so switching back reopens it. Transient (session-only). */
  previewSourceIdx?: 0 | 1 | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

class App {
  home = "/";
  tabsEl = el("div", "tabs"); // document (files) tabs, left
  sysTabsEl = el("div", "systabs"); // system tabs (Settings), right
  contentEl = el("div", "content");
  eyeBtn = el("button", "tbtn");
  themeBtn = el("button", "tbtn");
  devBtn = el("button", "tbtn");
  spBtn = el("button", "tbtn");
  views = new Map<number, TabView>();
  /** Native Quick Look: the pane whose cursor the QL panel is following. */
  private previewPane: PaneView | null = null;
  /** In-pane preview: the browsed (source) pane and the pane showing the preview. */
  private previewSource: PaneView | null = null;
  private previewTarget: PaneView | null = null;
  /** Live file operations' progress dialogs, keyed by op id. */
  private ops = new Map<string, ProgressHandle>();
  /** Combo string → command id, rebuilt whenever bindings change. */
  private comboMap = new Map<string, CommandId>();
  private commandHandlers: Record<CommandId, () => boolean | void> = {} as any;

  async init(): Promise<void> {
    const [saved, home, formats] = await Promise.all([
      invoke<any>("load_state").catch(() => null),
      invoke<string>("home_dir").catch(() => "/"),
      // The backend owns the archive format list; adopt it so the two can't drift.
      invoke<{ zipExts: string[]; suffixes: string[] }>("archive_formats").catch(() => null),
    ]);
    this.home = home;
    if (formats) setArchiveFormats(formats);
    this.restoreSettings(saved);
    document.documentElement.dataset.nameCase = state.settings.nameCase; // .pathinput / .locname case
    state.keybindings = mergeKeybindings(saved?.keybindings);
    state.columnOrder = normalizeColumnOrder(saved?.columnOrder);
    // Global column widths (fall back per-key to the defaults, and to an older
    // per-pane snapshot so existing configs keep their widths).
    {
      const num = (v: unknown, d: number) =>
        typeof v === "number" && isFinite(v) && v > 0 && v <= 20 ? v : d;
      const cw = saved?.columnWidths ?? saved?.tabs?.find((t: any) => t?.panes)?.panes?.[0]?.colWidths;
      state.columnWidths = {
        ext: num(cw?.ext, state.columnWidths.ext),
        size: num(cw?.size, state.columnWidths.size),
        created: num(cw?.created, state.columnWidths.created),
        perms: num(cw?.perms, state.columnWidths.perms),
        mod: num(cw?.mod, state.columnWidths.mod),
      };
    }

    // Restore saved locations; default to just the user's home. Re-derive any
    // name that looks like a path (a stale full-path name from before names were
    // split cross-platform — Windows `\` paths used to fall through as the whole
    // path) so favorites always read as the folder name.
    const savedLocs = Array.isArray(saved?.locations) ? saved.locations : null;
    state.locations =
      savedLocs
        ?.filter((l: any) => typeof l?.path === "string" && typeof l?.name === "string")
        .map((l: any) => ({
          path: l.path,
          name: /[\\/]/.test(l.name) ? baseName(l.path) : l.name,
        })) ?? [];
    if (state.locations.length === 0) {
      state.locations = [{ path: home, name: baseName(home) || "Home" }];
    }

    // Restore the recent-folders (visited) cache.
    state.visited = Array.isArray(saved?.visited)
      ? saved.visited
          .filter((v: any) => typeof v?.path === "string")
          .map((v: any) => ({ path: v.path, count: Number(v.count) || 1, last: Number(v.last) || 0 }))
      : [];
    rebuildVisitedIndex();

    // One-time: seed the user's Dropbox folder as a default favorite if they
    // have one. Guarded by a flag so a later removal is respected.
    state.dropboxSeeded = saved?.dropboxSeeded === true;
    if (!state.dropboxSeeded) {
      const db = await invoke<string | null>("dropbox_dir").catch(() => null);
      if (db && !state.locations.some((l) => l.path === db)) {
        state.locations.push({ path: db, name: "Dropbox" });
      }
      state.dropboxSeeded = true;
      persist();
    }

    applyTheme(state.settings.theme);
    this.applyZoomCss();
    this.buildShell();

    // Restore tabs (paths only; fall back to $HOME for anything stale).
    const savedTabs: any[] = Array.isArray(saved?.tabs) && saved.tabs.length ? saved.tabs : [];
    if (savedTabs.length === 0) {
      await this.addFilesTab([this.home, this.home]);
    } else {
      for (const t of savedTabs) {
        try {
          if (t?.kind === "settings") this.addSettingsTab(false);
          else if (t?.kind === "keybindings") this.addKeybindingsTab(false);
          else {
            const p0 = t?.panes?.[0] ?? {};
            const p1 = t?.panes?.[1] ?? {};
            await this.addFilesTab(
              [typeof p0.path === "string" ? p0.path : this.home,
               typeof p1.path === "string" ? p1.path : this.home],
              [p0, p1],
              t?.activePane === 1 ? 1 : 0,
              t?.single === true
            );
          }
        } catch {
          // A corrupt saved tab must never take the whole session down.
        }
      }
    }
    // Whatever happened above, the app always opens with a browsable tab.
    if (!state.tabs.some((t) => t.kind === "files"))
      await this.addFilesTab([this.home, this.home]);
    const wanted = typeof saved?.activeTab === "number" ? saved.activeTab : 0;
    this.activateTab(clamp(wanted, 0, state.tabs.length - 1));
    // The activateTab above fits titles before first layout; redo it once the
    // bar has real width. (Window resizes are handled by the observer/listener.)
    requestAnimationFrame(() => this.fitTabTitles());

    this.commandHandlers = {
      newTab: () => void this.newTab(),
      closeTab: () => this.closeTab(state.activeTab),
      nextTab: () => this.cycleTab(1),
      prevTab: () => this.cycleTab(-1),
      cycleTabs: () => this.cycleTab(1),
      openSettings: () => this.addSettingsTab(true),
      switchPane: () => this.switchPane(),
      cursorUp: () => this.activePane()?.moveCursor(-1),
      cursorDown: () => this.activePane()?.moveCursor(1),
      expand: () => this.activePane()?.expandCursor(),
      collapse: () => this.activePane()?.collapseCursor(),
      // →/←: jump to the next/previous recent ("blue") folder (⌘→/⌘← handle the
      // in-list tree). Always consumes the key, even when there's no folder to hit.
      nextVisited: () => {
        this.activePane()?.jumpVisited(1);
      },
      prevVisited: () => {
        this.activePane()?.jumpVisited(-1);
      },
      pageUp: () => this.activePane()?.movePage(-1),
      pageDown: () => this.activePane()?.movePage(1),
      cursorHome: () => this.activePane()?.moveHome(),
      cursorEnd: () => this.activePane()?.moveEnd(),
      open: () => this.activePane()?.openCursor(),
      up: () => this.activePane()?.goUp(),
      editFile: () => void this.doEdit(),
      copyToOther: () => void this.doTransfer(false),
      moveToOther: () => void this.doTransfer(true),
      rename: () => void this.doRename(),
      newFolder: () => void this.doNewFolder(),
      trash: () => void this.doTrash(),
      toggleMark: () => this.activePane()?.markCursorAndAdvance(),
      markItem: () => this.activePane()?.markCursor(true),
      unmarkItem: () => this.activePane()?.markCursor(false),
      selectUp: () => this.activePane()?.extendCursor(-1),
      selectDown: () => this.activePane()?.extendCursor(1),
      selectAll: () => this.activePane()?.selectAll(),
      selectGroup: () => void this.doSelectByMask(true),
      unselectGroup: () => void this.doSelectByMask(false),
      sortName: () => this.activePane()?.cycleSort("name"),
      sortExt: () => this.activePane()?.cycleSort("ext"),
      sortSize: () => this.activePane()?.cycleSort("size"),
      sortCreated: () => this.activePane()?.cycleSort("created"),
      sortModified: () => this.activePane()?.cycleSort("modified"),
      viewList: () => this.activePane()?.setView("list"),
      viewChips: () => this.activePane()?.setView("chips"),
      viewGrid: () => this.activePane()?.setView("grid"),
      toggleSingle: () => this.toggleSingle(),
      zoomIn: () => this.zoomStep(1),
      zoomOut: () => this.zoomStep(-1),
      zoomReset: () => this.setZoom(state.settings.defaultZoom, true),
      toggleHidden: () => this.toggleHidden(),
      preview: () => this.doPreview(),
      closePreview: () => this.closePanePreview(),
      devtools: () => {
        if (state.settings.devTools) void invoke("toggle_devtools").catch(() => {});
      },
      favoritesLeft: () => this.openFavorites(0),
      favoritesRight: () => this.openFavorites(1),
      drivesLeft: () => this.openDrives(0),
      drivesRight: () => this.openDrives(1),
      enterArchive: () => this.activePane()?.enterArchive(),
    };
    this.rebuildComboMap();
    initKeyboard({
      lookup: () => this.comboMap,
      run: (id) => this.commandHandlers[id]?.(),
    });

    // Quick Look reports its current item as the user arrows; follow it.
    onEvent<number>("ql-index", (idx) => this.previewPane?.applyPreviewIndex(idx));

    // File operations stream byte/item progress; route it to the op's dialog.
    onEvent<OpProgress>("op-progress", (p) => this.ops.get(p.id)?.update(p));

    // The native window starts hidden (visible: false) to avoid a white flash
    // while the page loads. Now that the shell is built and the first tab is
    // rendered, reveal it after two animation frames (one to lay out, one to
    // paint). No-op in the browser; the backend has a 3s failsafe either way.
    if (isTauri) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void invoke("show_main_window").catch(() => {}))
      );
    }
  }

  private restoreSettings(saved: any): void {
    const s = saved?.settings;
    if (s) {
      if (["light", "dark", "system"].includes(s.theme)) state.settings.theme = s.theme;
      if (typeof s.showHidden === "boolean") state.settings.showHidden = s.showHidden;
      if (ZOOM_LEVELS.includes(s.defaultZoom)) state.settings.defaultZoom = s.defaultZoom;
      if (typeof s.lowercaseTabs === "boolean") state.settings.lowercaseTabs = s.lowercaseTabs;
      if (typeof s.systemIcons === "boolean") state.settings.systemIcons = s.systemIcons;
      if (typeof s.chipCards === "boolean") state.settings.chipCards = s.chipCards;
      if (typeof s.bigChips === "boolean") state.settings.bigChips = s.bigChips;
      if (typeof s.folderChips === "boolean") state.settings.folderChips = s.folderChips;
      if (typeof s.launchApps === "boolean") state.settings.launchApps = s.launchApps;
      if (typeof s.previewIcons === "boolean") state.settings.previewIcons = s.previewIcons;
      if (typeof s.highlightToday === "boolean") state.settings.highlightToday = s.highlightToday;
      if (typeof s.stripedRows === "boolean") state.settings.stripedRows = s.stripedRows;
      if (typeof s.sizeBars === "boolean") state.settings.sizeBars = s.sizeBars;
      if (typeof s.sizeBarLog === "boolean") state.settings.sizeBarLog = s.sizeBarLog;
      if (typeof s.previewPane === "boolean") state.settings.previewPane = s.previewPane;
      if (PREVIEW_SIZES.includes(s.previewSize)) state.settings.previewSize = s.previewSize;
      if (CODE_PREVIEW_BYTES.includes(s.codePreviewBytes)) state.settings.codePreviewBytes = s.codePreviewBytes;
      if (typeof s.showCreated === "boolean") state.settings.showCreated = s.showCreated;
      if (typeof s.showPermissions === "boolean") state.settings.showPermissions = s.showPermissions;
      if (["original", "lower", "upper"].includes(s.nameCase)) state.settings.nameCase = s.nameCase;
      if (["system", "/", "\\"].includes(s.pathSep)) state.settings.pathSep = s.pathSep;
      if (typeof s.foldersOnTop === "boolean") state.settings.foldersOnTop = s.foldersOnTop;
      if (VISITED_SIZES.includes(s.visitedCacheSize)) state.settings.visitedCacheSize = s.visitedCacheSize;
      if (typeof s.linkedSort === "boolean") state.settings.linkedSort = s.linkedSort;
      if (typeof s.confirmOps === "boolean") state.settings.confirmOps = s.confirmOps;
      if (typeof s.editorPath === "string") state.settings.editorPath = s.editorPath;
      if (typeof s.devTools === "boolean") state.settings.devTools = s.devTools;
    }
    state.zoom = ZOOM_LEVELS.includes(saved?.zoom) ? saved.zoom : state.settings.defaultZoom;
  }

  private buildShell(): void {
    const root = document.getElementById("app")!;
    // Native window: the tab bar doubles as the OS title bar. On macOS the
    // traffic lights overlay it top-left (the `.mac` class enables the left
    // inset); Windows/Linux keep standard window chrome, so no inset. The
    // browser preview stays a normal full-width bar.
    if (isTauri) {
      document.documentElement.classList.add("native");
      if (isMac) document.documentElement.classList.add("mac");
    }
    const tabbar = el("div", "tabbar");
    tabbar.setAttribute("data-tauri-drag-region", "");

    const newBtn = el("button", "tbtn");
    newBtn.innerHTML = icons.plus;
    newBtn.title = `New tab (${hint("newTab")})`;
    newBtn.addEventListener("click", () => void this.newTab());

    this.eyeBtn.innerHTML = icons.eye;
    this.eyeBtn.title = `Show hidden files (${hint("toggleHidden")})`;
    this.eyeBtn.addEventListener("click", () => this.toggleHidden());

    this.spBtn.innerHTML = icons.sidebar;
    this.spBtn.title = `Single-pane view (${hint("toggleSingle")})`;
    this.spBtn.addEventListener("click", () => this.toggleSingle());

    this.themeBtn.addEventListener("click", () => this.toggleTheme());
    // Keep the icon in sync when the OS appearance flips while in System mode.
    onThemeChange(() => this.syncThemeBtn());

    this.devBtn.innerHTML = icons.code;
    this.devBtn.title = `Developer tools (${hint("devtools")})`;
    this.devBtn.addEventListener("click", () => void invoke("toggle_devtools").catch(() => {}));

    const gearBtn = el("button", "tbtn");
    gearBtn.innerHTML = icons.gear;
    gearBtn.title = `Settings (${hint("openSettings")})`;
    gearBtn.addEventListener("click", () => this.addSettingsTab(true));

    const spacer = el("div", "flexspace");
    spacer.setAttribute("data-tauri-drag-region", ""); // main window-drag zone
    // Layout: [files tabs][+] …spacer… [system tabs][single][theme][eye][dev][gear]
    tabbar.append(this.tabsEl, newBtn, spacer, this.sysTabsEl, this.spBtn, this.themeBtn, this.eyeBtn, this.devBtn, gearBtn);
    root.append(tabbar, this.contentEl);
    this.syncEye();
    this.syncThemeBtn();
    this.syncDevBtn();
    // Re-fit tab titles whenever the available width changes.
    new ResizeObserver(() => this.fitTabTitles()).observe(tabbar);
    window.addEventListener("resize", () => this.fitTabTitles());
  }

  /** Widen tab titles when the strip has room; shrink toward ellipsis when
      crowded. "Enough space" means few enough tabs that each gets its full
      title at up to 1.5x the base width. */
  private fitTabTitles(): void {
    const bar = this.tabsEl.parentElement;
    if (!bar || state.tabs.length === 0) return;
    // Before first layout clientWidth is 0 — measuring then yields garbage, so
    // leave the CSS default (WIDE) until a real measurement is possible.
    if (bar.clientWidth === 0) return;
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const WIDE = 13.5 * rootPx; // 1.5x the previous 9rem cap
    const MIN = 5 * rootPx; // floor before ellipsis takes over
    const CHROME = 2.6 * rootPx; // per-tab padding + close button + inner gap

    const barCS = getComputedStyle(bar);
    const gap = parseFloat(barCS.gap) || 0;
    const padX = parseFloat(barCS.paddingLeft) + parseFloat(barCS.paddingRight);
    let reserved = 0;
    for (const child of bar.children) {
      const c = child as HTMLElement;
      if (c === this.tabsEl || c.classList.contains("flexspace")) continue;
      reserved += c.getBoundingClientRect().width;
    }
    const gaps = gap * (bar.children.length - 1);
    // System tabs sit in their own right-hand container (counted in `reserved`),
    // so the left budget is split across the files tabs only.
    const filesCount = state.tabs.filter((t) => t.kind === "files").length || 1;
    const available = bar.clientWidth - padX - reserved - gaps;
    const budget = available / filesCount - CHROME;
    const max = clamp(budget, MIN, WIDE);
    this.tabsEl.style.setProperty("--tab-title-max", `${Math.floor(max)}px`);
  }

  // ---- tabs ----------------------------------------------------------------

  private paneHost(tab: Tab, index: 0 | 1) {
    const pane = () => this.views.get(tab.id)?.panes?.[index] ?? null;
    return {
      activate: () => {
        // Clicking the pane that's showing a preview dismisses it and browses.
        if (this.previewTarget && pane() === this.previewTarget) this.closePanePreview();
        tab.activePane = index;
        this.syncPaneActive(tab);
      },
      changed: () => {
        // Keep an open preview alive when the browsed pane navigates or re-sorts —
        // just re-point it at the new cursor item (Finder-style: the preview pane
        // stays up across folder changes until you dismiss it with Space).
        if (this.previewSource && pane() === this.previewSource) this.refreshPanePreview();
        // Single-pane: keep the sidebar's "current" highlight in sync as the main pane navigates.
        if (tab.single && index === 0) this.views.get(tab.id)?.sidebar?.render();
        this.renderTabstrip();
        persist();
      },
      cursorMoved: () => {
        if (this.previewTarget && pane() === this.previewSource) this.refreshPanePreview();
      },
      sortChanged: (key: SortKey, dir: SortDir) => {
        if (!state.settings.linkedSort) return;
        const panes = this.views.get(tab.id)?.panes;
        panes?.[index === 0 ? 1 : 0]?.applySort(key, dir);
      },
      columnsChanged: () => {
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshColumns());
      },
      showHidden: () => state.settings.showHidden,
      sysIcons: () => state.settings.systemIcons,
      locations: () => state.locations,
      addLocation: (path: string, name: string) => this.addFavorite(path, name),
      removeLocation: (path: string) => this.removeFavorite(path),
      moveLocation: (from: number, to: number) => this.moveFavorite(from, to),
    };
  }

  private async addFilesTab(
    paths: [string, string],
    restored?: any[],
    activePane: 0 | 1 = 0,
    single = false
  ): Promise<void> {
    const num = (v: unknown, dflt: number) =>
      typeof v === "number" && isFinite(v) && v > 0 && v <= 20 ? v : dflt;
    const mk = (path: string, r?: any): PaneState => ({
      path,
      listing: null,
      sortKey: ["name", "ext", "size", "modified"].includes(r?.sortKey) ? r.sortKey : "name",
      sortDir: r?.sortDir === -1 ? -1 : 1,
      cursor: 0,
      colWidths: {
        ext: num(r?.colWidths?.ext, 3.25),
        size: num(r?.colWidths?.size, 5.25),
        created: num(r?.colWidths?.created, 8.5),
        perms: num(r?.colWidths?.perms, 6),
        mod: num(r?.colWidths?.mod, 8.5),
      },
      // Honor any persisted mode; fresh panes default to chips (the "Big Chips"
      // view). Previously "chips" was wrongly coerced to "list" on restore.
      viewMode:
        r?.viewMode === "grid" || r?.viewMode === "chips" || r?.viewMode === "list"
          ? r.viewMode
          : "chips",
      gridSize: clamp(num(r?.gridSize, GRID_DEFAULT), GRID_MIN, GRID_MAX),
      colOrder: Array.isArray(r?.colOrder) ? normalizeColumnOrder(r.colOrder) : undefined,
    });
    const tab: Tab = {
      id: newTabId(),
      kind: "files",
      activePane: single ? 0 : activePane,
      single,
      panes: [mk(paths[0], restored?.[0]), mk(paths[1], restored?.[1])],
    };
    const wrap = el("div", "tabview");
    const dual = el("div", "dual");
    const pv0 = new PaneView(tab.panes![0], this.paneHost(tab, 0));
    const pv1 = new PaneView(tab.panes![1], this.paneHost(tab, 1));
    const sidebar = new FavSidebar(this.favSidebarHost(tab));
    dual.append(sidebar.el, pv0.el, pv1.el);
    wrap.append(dual);
    this.contentEl.append(wrap);

    state.tabs.push(tab);
    this.views.set(tab.id, { el: wrap, panes: [pv0, pv1], dual, sidebar });
    this.applySingle(tab);
    this.syncPaneActive(tab);

    for (const [pv, path] of [[pv0, paths[0]], [pv1, paths[1]]] as const) {
      if (!(await pv.navigate(path)) && path !== this.home) await pv.navigate(this.home);
    }
    this.renderTabstrip();
  }

  private addSettingsTab(activate: boolean): void {
    const existing = state.tabs.findIndex((t) => t.kind === "settings");
    if (existing >= 0) {
      if (activate) this.activateTab(existing);
      return;
    }
    const tab: Tab = { id: newTabId(), kind: "settings", activePane: 0, panes: null };
    const wrap = el("div", "tabview");
    const page = buildSettingsPage({
      get: () => state.settings,
      onTheme: (t: Theme) => {
        state.settings.theme = t;
        applyTheme(t);
        persist();
      },
      onHidden: (v) => this.setHidden(v),
      onDefaultZoom: (z) => {
        state.settings.defaultZoom = z;
        this.setZoom(z, true);
      },
      onLowercaseTabs: (v) => {
        state.settings.lowercaseTabs = v;
        this.renderTabstrip();
        persist();
      },
      onSystemIcons: (v) => {
        state.settings.systemIcons = v;
        // Re-render visible rows in every pane so icons switch immediately.
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onChipCards: (v) => {
        state.settings.chipCards = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onBigChips: (v) => {
        state.settings.bigChips = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onFolderChips: (v) => {
        state.settings.folderChips = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onLaunchApps: (v) => {
        state.settings.launchApps = v;
        // Re-render so .app icons / disclosure triangles update immediately.
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onPreviewIcons: (v) => {
        state.settings.previewIcons = v;
        // Re-render visible rows in every pane so thumbnails appear/disappear.
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onHighlightToday: (v) => {
        state.settings.highlightToday = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onStripedRows: (v) => {
        state.settings.stripedRows = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onSizeBars: (v) => {
        state.settings.sizeBars = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onSizeBarLog: (v) => {
        state.settings.sizeBarLog = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onPreviewPane: (v) => {
        state.settings.previewPane = v;
        if (!v) this.closePanePreview(); // leaving in-pane mode drops any open preview
        persist();
      },
      onPreviewSize: (n) => {
        state.settings.previewSize = n;
        this.refreshPanePreview(); // re-fetch the open preview at the new resolution
        persist();
      },
      onCodePreviewBytes: (n) => {
        state.settings.codePreviewBytes = n;
        this.refreshPanePreview(); // re-read the open preview at the new cap
        persist();
      },
      onShowCreated: (v) => {
        state.settings.showCreated = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshColumns());
        persist();
      },
      onShowPermissions: (v) => {
        state.settings.showPermissions = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshColumns());
        persist();
      },
      onNameCase: (c) => {
        state.settings.nameCase = c;
        document.documentElement.dataset.nameCase = c; // drives .pathinput / .locname CSS
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onPathSep: (sep) => {
        state.settings.pathSep = sep;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshPathBar());
        this.renderTabstrip();
        this.refreshSidebars(); // drive-root "\" / "/" in the left-pane favorites
        persist();
      },
      onFoldersOnTop: (v) => {
        state.settings.foldersOnTop = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshView());
        persist();
      },
      onVisitedCacheSize: (n) => {
        state.settings.visitedCacheSize = n;
        // Enforce the new cap immediately (evicts oldest / clears when 0).
        if (n <= 0) clearVisited();
        else if (state.visited.length > n) {
          state.visited.sort((a, b) => b.last - a.last);
          state.visited = state.visited.slice(0, n);
          rebuildVisitedIndex();
        }
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
      },
      onClearVisited: () => {
        clearVisited();
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
      },
      onLinkedSort: (v) => {
        state.settings.linkedSort = v;
        if (v) {
          // Adopt the left pane's sort in the right pane of every tab.
          for (const view of this.views.values()) {
            const [a, b] = view.panes ?? [];
            if (a && b) b.applySort(a.st.sortKey, a.st.sortDir);
          }
        }
        persist();
      },
      onConfirmOps: (v) => {
        state.settings.confirmOps = v;
        persist();
      },
      onEditorPath: (v) => {
        state.settings.editorPath = v;
        persist();
      },
      onDevTools: (v) => {
        state.settings.devTools = v;
        this.syncDevBtn();
        // Turning it off closes the inspector if it's currently open.
        if (!v) void invoke("close_devtools").catch(() => {});
        persist();
      },
      onOpenKeybindings: () => this.addKeybindingsTab(true),
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    state.tabs.push(tab);
    this.views.set(tab.id, { el: wrap, panes: null, settings: page });
    // Build the strip first so the new tab's element exists, then activate
    // (activateTab only toggles classes, it doesn't rebuild the strip).
    this.renderTabstrip();
    if (activate) this.activateTab(state.tabs.length - 1);
    persist();
  }

  private addKeybindingsTab(activate: boolean): void {
    const existing = state.tabs.findIndex((t) => t.kind === "keybindings");
    if (existing >= 0) {
      if (activate) this.activateTab(existing);
      return;
    }
    const tab: Tab = { id: newTabId(), kind: "keybindings", activePane: 0, panes: null };
    const wrap = el("div", "tabview");
    const page = buildKeybindingsPage({
      get: () => state.keybindings,
      add: (id, combo) => {
        // A combo binds to exactly one command — steal it from any current owner.
        const prev = this.comboMap.get(combo);
        for (const cid of Object.keys(state.keybindings) as CommandId[]) {
          state.keybindings[cid] = state.keybindings[cid].filter((c) => c !== combo);
        }
        if (!state.keybindings[id].includes(combo)) state.keybindings[id].push(combo);
        if (prev && prev !== id) {
          const label = COMMANDS.find((c) => c.id === prev)?.label ?? prev;
          toast(`Reassigned from “${label}”`);
        }
        this.afterBindingsChanged();
      },
      remove: (id, combo) => {
        state.keybindings[id] = (state.keybindings[id] ?? []).filter((c) => c !== combo);
        this.afterBindingsChanged();
      },
      owner: (combo) => this.comboMap.get(combo) ?? null,
      reset: () => {
        state.keybindings = mergeKeybindings(null); // null → pure defaults
        this.afterBindingsChanged();
      },
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    state.tabs.push(tab);
    this.views.set(tab.id, { el: wrap, panes: null, keybindings: page });
    this.renderTabstrip();
    if (activate) this.activateTab(state.tabs.length - 1);
    persist();
  }

  async newTab(): Promise<void> {
    const cur = state.tabs[state.activeTab];
    const paths: [string, string] =
      cur?.panes ? [cur.panes[0].path, cur.panes[1].path] : [this.home, this.home];
    // Clone sorts and column widths too — a new tab should feel like "more of
    // the same place", not a reset.
    const restored = cur?.panes?.map((p) => ({
      sortKey: p.sortKey,
      sortDir: p.sortDir,
      colWidths: { ...p.colWidths },
      viewMode: p.viewMode,
      gridSize: p.gridSize,
    }));
    await this.addFilesTab(paths, restored);
    this.activateTab(state.tabs.length - 1);
  }

  private closeTabById(id: number): void {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i >= 0) this.closeTab(i);
  }

  closeTab(i: number): void {
    if (state.tabs.length <= 1) return; // never close the last tab
    const tab = state.tabs[i];
    if (!tab) return;
    this.views.get(tab.id)?.el.remove();
    this.views.delete(tab.id);
    state.tabs.splice(i, 1);
    state.activeTab = clamp(
      state.activeTab > i ? state.activeTab - 1 : state.activeTab,
      0,
      state.tabs.length - 1
    );
    this.renderTabstrip(); // structure changed — rebuild the strip
    this.applyActiveTab();
    persist();
  }

  activateTab(i: number): void {
    // A preview belongs to the tab it was opened in: stash whether the outgoing
    // tab had one, close it, then reopen the incoming tab's own preview (if any).
    this.rememberPanePreview();
    this.closePanePreview();
    state.activeTab = clamp(i, 0, state.tabs.length - 1);
    this.applyActiveTab();
    this.syncActiveTabClass();
    this.restorePanePreview();
    persist();
  }

  /** Show the active tab's view and sync a settings tab if that's the one. */
  private applyActiveTab(): void {
    state.tabs.forEach((t, j) => {
      const v = this.views.get(t.id);
      v?.el.classList.toggle("active", j === state.activeTab);
      if (j === state.activeTab && t.kind === "settings") v?.settings?.sync();
      if (j === state.activeTab && t.kind === "keybindings") v?.keybindings?.sync();
    });
    this.syncSingleBtn();
  }

  cycleTab(d: 1 | -1): void {
    // Cycle only through file tabs — skip the Settings / Shortcuts system tabs.
    const files = state.tabs.filter((t) => t.kind === "files");
    if (files.length === 0) return;
    const cur = state.tabs[state.activeTab];
    const i = files.indexOf(cur);
    const next =
      i === -1 ? files[d > 0 ? 0 : files.length - 1] : files[(i + d + files.length) % files.length];
    this.activateTab(state.tabs.indexOf(next));
  }

  private tabTitle(tab: Tab): string {
    if (tab.kind === "settings") return "Settings";
    if (tab.kind === "keybindings") return "Shortcuts";
    const name = (p: PaneState) => p.listing?.name || p.path || "—";
    // Single-pane mode browses one pane (pane 0; pane 1 is only the preview), so
    // the tab shows just that dir — not the "left - right" pair.
    const raw = tab.single
      ? name(tab.panes![0])
      : `${name(tab.panes![0])} - ${name(tab.panes![1])}`;
    const title = withSep(raw, state.settings.pathSep);
    return state.settings.lowercaseTabs ? title.toLowerCase() : title;
  }

  private buildTabEl(tab: Tab): HTMLElement {
    const t = el("div", "tab" + (state.tabs[state.activeTab]?.id === tab.id ? " active" : ""));
    t.dataset.tabId = String(tab.id);
    const title = el("span", "tabtitle");
    title.textContent = this.tabTitle(tab);
    const close = el("span", "tabclose");
    close.innerHTML = icons.close;
    close.title = `Close tab (${hint("closeTab")})`;
    t.append(title, close);
    t.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".tabclose")) return;
      const idx = state.tabs.indexOf(tab);
      if (idx >= 0) this.activateTab(idx);
      if (tab.kind === "files") this.beginTabDrag(e, t, tab); // only doc tabs reorder
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTabById(tab.id);
    });
    t.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.closeTabById(tab.id);
    });
    return t;
  }

  renderTabstrip(): void {
    const filesFrag = document.createDocumentFragment();
    const sysFrag = document.createDocumentFragment();
    for (const tab of state.tabs) {
      const t = this.buildTabEl(tab);
      (tab.kind === "files" ? filesFrag : sysFrag).append(t);
    }
    this.tabsEl.replaceChildren(filesFrag);
    this.sysTabsEl.replaceChildren(sysFrag);
    this.fitTabTitles();
  }

  /** Reflect the active tab without rebuilding the strip — keeps element
      identity stable so an in-progress drag holds its node. */
  private syncActiveTabClass(): void {
    const activeId = state.tabs[state.activeTab]?.id;
    for (const c of [...this.tabsEl.children, ...this.sysTabsEl.children]) {
      const e = c as HTMLElement;
      e.classList.toggle("active", Number(e.dataset.tabId) === activeId);
    }
  }

  // ---- tab dragging (reorder document tabs) ---------------------------------

  private beginTabDrag(startEvent: MouseEvent, tabEl: HTMLElement, tab: Tab): void {
    const container = this.tabsEl;
    const pointerStart = startEvent.clientX;
    const homeLeft = tabEl.offsetLeft;
    let dragging = false;

    // FLIP-animate the non-dragged tabs as they shift to make room.
    const flip = (mutate: () => void) => {
      const sibs = [...container.querySelectorAll<HTMLElement>(".tab")].filter((s) => s !== tabEl);
      const before = new Map(sibs.map((s) => [s, s.getBoundingClientRect().left]));
      mutate();
      for (const s of sibs) {
        const dx = (before.get(s) ?? 0) - s.getBoundingClientRect().left;
        if (!dx) continue;
        s.style.transition = "none";
        s.style.transform = `translateX(${dx}px)`;
        requestAnimationFrame(() => {
          s.style.transition = "transform 0.15s ease";
          s.style.transform = "";
        });
      }
    };

    const onMove = (e: MouseEvent) => {
      const raw = e.clientX - pointerStart;
      if (!dragging) {
        if (Math.abs(raw) < 4) return; // small movements are still a click
        dragging = true;
        tabEl.classList.add("dragging");
        document.body.classList.add("tab-dragging");
      }
      // Keep the tab under the pointer even after the DOM reorders beneath it.
      tabEl.style.transform = `translateX(${raw - (tabEl.offsetLeft - homeLeft)}px)`;

      const visualCenter = homeLeft + raw + tabEl.offsetWidth / 2;
      const sibs = [...container.querySelectorAll<HTMLElement>(".tab")].filter((s) => s !== tabEl);
      let target = 0;
      for (const s of sibs) if (visualCenter > s.offsetLeft + s.offsetWidth / 2) target++;
      const curIdx = [...container.querySelectorAll(".tab")].indexOf(tabEl);
      if (target !== curIdx) flip(() => container.insertBefore(tabEl, sibs[target] ?? null));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("tab-dragging");
      if (dragging) this.commitTabOrderFromDom();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Rebuild state.tabs from the current DOM order of the files strip. */
  private commitTabOrderFromDom(): void {
    const activeId = state.tabs[state.activeTab]?.id;
    const domIds = [...this.tabsEl.querySelectorAll<HTMLElement>(".tab")].map((e) =>
      Number(e.dataset.tabId)
    );
    const files = domIds
      .map((id) => state.tabs.find((t) => t.id === id))
      .filter((t): t is Tab => !!t);
    const sys = state.tabs.filter((t) => t.kind !== "files");
    state.tabs = [...files, ...sys];
    if (activeId != null) {
      const j = state.tabs.findIndex((t) => t.id === activeId);
      if (j >= 0) state.activeTab = j;
    }
    this.renderTabstrip(); // fresh nodes clear inline drag transforms
    persist();
  }

  // ---- panes ---------------------------------------------------------------

  private syncPaneActive(tab: Tab): void {
    const v = this.views.get(tab.id);
    v?.panes?.forEach((p, j) => p.setActive(j === tab.activePane));
  }

  private activePane(): PaneView | null {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes) return null;
    return this.views.get(tab.id)?.panes?.[tab.activePane] ?? null;
  }

  /** The non-active pane of the current tab (destination for copy/move). */
  private otherPane(): PaneView | null {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes || tab.single) return null;
    return this.views.get(tab.id)?.panes?.[tab.activePane === 0 ? 1 : 0] ?? null;
  }

  // ---- file operations -------------------------------------------------------

  private plural(n: number, one: string): string {
    return `${n} ${one}${n === 1 ? "" : "s"}`;
  }

  /** Full child path within `dir` (root-aware), for the into-itself guard. */
  private childPath(dir: string, name: string): string {
    return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
  }

  /** Copy (move=false) or move (move=true) the active pane's selection into the
      other pane's folder — Norton Commander F5/F6. */
  private async doTransfer(move: boolean): Promise<void> {
    const src = this.activePane();
    const dst = this.otherPane();
    if (!src || !dst) {
      toast("Needs two panes");
      return;
    }
    const items = src.selectedItems();
    if (!items.length) return;
    const destDir = dst.currentPath();
    const verb = move ? "Move" : "Copy";

    // Archives are read-only: copy-out is fine, everything else isn't.
    if (dst.isReadOnly()) {
      toast("Can’t write into an archive");
      return;
    }
    if (move && src.isReadOnly()) {
      toast("Can’t move out of an archive — copy it instead");
      return;
    }

    // Guard: don't put a folder inside itself or a descendant of itself.
    for (const it of items) {
      const p = this.childPath(it.dir, it.name);
      if (it.isDir && (destDir === p || destDir.startsWith(p + "/"))) {
        toast(`Can’t ${verb.toLowerCase()} “${it.name}” into itself`);
        return;
      }
    }
    const sameDir = items[0].dir === destDir;
    if (move && sameDir) {
      toast("Already in that folder");
      return;
    }

    // Conflicts = items whose name already exists in the destination (the other
    // pane's listing is in memory). Same-dir copies auto-rename, so never clash.
    const conflicts = sameDir ? [] : items.filter((it) => dst.hasEntry(it.name)).map((it) => it.name);

    let overwrite = false;
    if (state.settings.confirmOps || conflicts.length) {
      let message = `${verb} ${this.plural(items.length, "item")} to ${destDir}?`;
      if (conflicts.length) message += `\n\n${this.plural(conflicts.length, "item")} already there and will be replaced.`;
      const ok = await confirmDialog({ title: `${verb} items`, message, confirmLabel: verb, danger: move });
      if (!ok) return;
      overwrite = conflicts.length > 0;
    }

    const res = await this.runWithProgress(move ? "Moving" : "Copying", move ? "move_entries" : "copy_entries", {
      items: items.map(({ dir, name }) => ({ dir, name })),
      dest: destDir,
      overwrite,
    });
    if (!res) return;
    await Promise.all([src.softReload(), dst.softReload()]);
    const past = move ? "Moved" : "Copied";
    const done = res.done.length;
    if (res.cancelled) {
      toast(`Cancelled — ${past.toLowerCase()} ${done} before stopping`);
    } else {
      toast(
        res.skipped.length
          ? `${past} ${done}, skipped ${res.skipped.length}`
          : `${past} ${this.plural(done, "item")}`
      );
    }
  }

  /** Run a mutating backend op (copy/move/trash) behind a progress dialog that the
      user can send to the background or cancel. Resolves with the OpResult, or null
      if it errored (already toasted). */
  private async runWithProgress(
    title: string,
    cmd: string,
    args: Record<string, unknown>,
    retried = false
  ): Promise<OpResult | null> {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random()}`;
    const handle = new ProgressHandle({
      title,
      onCancel: () => void invoke("cancel_op", { id }),
    });
    this.ops.set(id, handle);
    try {
      return await invoke<OpResult>(cmd, { id, ...args });
    } catch (e) {
      // An encrypted zip lists fine but fails on read, so the prompt can land
      // here rather than at navigation time.
      if (!retried && needsPassword(e)) {
        // Close the progress dialog FIRST: it sits above the modal layer, so a
        // prompt raised underneath it would be invisible and unclickable.
        this.ops.delete(id);
        handle.close();
        const first = (args.items as { dir: string }[] | undefined)?.[0]?.dir ?? "";
        const file = archiveFileFor(first);
        if (file && (await askArchivePassword(file, true))) {
          return this.runWithProgress(title, cmd, args, true);
        }
        return null;
      }
      toast(String(e));
      return null;
    } finally {
      this.ops.delete(id);
      handle.close();
    }
  }

  /** F4: open the cursor file in the external editor (Buffers). */
  private async doEdit(): Promise<void> {
    const p = this.activePane();
    const it = p?.cursorItem();
    if (!it) return;
    if (p?.isReadOnly()) {
      toast("Copy it out first (F5)");
      return;
    }
    if (it.isDir) {
      toast("Can’t edit a folder");
      return;
    }
    const exe = state.settings.editorPath.trim();
    if (!exe) {
      toast("Set the editor path in Settings first");
      return;
    }
    try {
      await invoke("open_in_editor", { exe, path: this.childPath(it.dir, it.name) });
    } catch (e) {
      toast(String(e));
    }
  }

  private async doRename(): Promise<void> {
    const p = this.activePane();
    const it = p?.cursorItem();
    if (!p || !it) return;
    if (p.isReadOnly()) {
      toast("Can’t rename inside an archive");
      return;
    }
    const newName = await promptDialog({
      title: "Rename",
      value: it.name,
      confirmLabel: "Rename",
      selectStem: !it.isDir,
      validate: (v) => {
        const t = v.trim();
        if (!t) return "Name can’t be empty";
        if (t === "." || t === "..") return "That name is reserved";
        if (t.includes("/")) return "Name can’t contain “/”";
        if (t !== it.name && p.hasEntry(t)) return `“${t}” already exists`;
        return null;
      },
    });
    if (newName == null) return;
    const t = newName.trim();
    if (t === it.name) return;
    try {
      await invoke("rename_entry", { dir: it.dir, name: it.name, newName: t });
      await p.softReload();
      p.selectByName(t);
    } catch (e) {
      toast(String(e));
    }
  }

  /** + / − (Total Commander's "select group"): ask for a wildcard mask, then
      mark or unmark every matching item in the active pane. */
  private async doSelectByMask(select: boolean): Promise<void> {
    const p = this.activePane();
    if (!p) return;
    const mask = await promptDialog({
      title: select ? "Select items matching" : "Deselect items matching",
      value: "*.*",
      placeholder: "*.txt;*.md",
      confirmLabel: select ? "Select" : "Deselect",
    });
    if (mask == null) return;
    const n = p.selectByMask(mask, select);
    if (!n) toast("No matching items");
    else toast(`${select ? "Selected" : "Deselected"} ${n} item${n === 1 ? "" : "s"}`);
  }

  private async doNewFolder(): Promise<void> {
    const p = this.activePane();
    if (!p) return;
    if (p.isReadOnly()) {
      toast("Can’t create a folder inside an archive");
      return;
    }
    const dir = p.currentPath();
    const name = await promptDialog({
      title: "New folder",
      value: "untitled folder",
      confirmLabel: "Create",
      validate: (v) => {
        const t = v.trim();
        if (!t) return "Name can’t be empty";
        if (t === "." || t === "..") return "That name is reserved";
        if (t.includes("/")) return "Name can’t contain “/”";
        if (p.hasEntry(t)) return `“${t}” already exists`;
        return null;
      },
    });
    if (name == null) return;
    const t = name.trim();
    try {
      await invoke("create_folder", { dir, name: t });
      await p.softReload();
      p.selectByName(t);
    } catch (e) {
      toast(String(e));
    }
  }

  private async doTrash(): Promise<void> {
    const p = this.activePane();
    if (!p) return;
    if (p.isReadOnly()) {
      toast("Can’t delete inside an archive");
      return;
    }
    const items = p.selectedItems();
    if (!items.length) return;
    if (state.settings.confirmOps) {
      const what = items.length === 1 ? `“${items[0].name}”` : this.plural(items.length, "item");
      const ok = await confirmDialog({
        title: "Move to Trash",
        message: `Move ${what} to the Trash?`,
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) return;
    }
    const res = await this.runWithProgress("Deleting", "trash_entries", {
      items: items.map(({ dir, name }) => ({ dir, name })),
    });
    if (!res) return;
    await p.softReload();
    if (res.cancelled) toast(`Cancelled — moved ${res.done.length} to Trash`);
    else toast(`Moved ${this.plural(res.done.length, "item")} to Trash`);
  }

  switchPane(): boolean {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes) return false;
    // If a code preview is open, Tab hops the cursor INTO it (arrows then walk
    // lines); the editor's own Tab hops back out to the file list. Keep the
    // preview open and don't switch the active pane.
    if (this.previewTarget?.focusCodePreview()) return true;
    if (tab.single) return false; // single mode has only one pane
    this.closePanePreview(); // the opposite pane is about to become active
    tab.activePane = tab.activePane === 0 ? 1 : 0;
    this.syncPaneActive(tab);
    this.renderTabstrip();
    return true;
  }

  // ---- single-pane mode + favorites sidebar ---------------------------------

  private favSidebarHost(tab: Tab) {
    const main = () => this.views.get(tab.id)?.panes?.[0] ?? null;
    return {
      locations: () => state.locations,
      currentPath: () => main()?.st.path ?? null,
      navigate: (path: string) => void main()?.navigate(path),
      addLocation: (path: string, name: string) => this.addFavorite(path, name),
      removeLocation: (path: string) => this.removeFavorite(path),
      moveLocation: (from: number, to: number) => this.moveFavorite(from, to),
      sysIcons: () => state.settings.systemIcons,
    };
  }

  private addFavorite(path: string, name: string): void {
    // A location inside an archive isn't bookmarkable: it only exists while that
    // archive does, and the saved path would carry the internal boundary marker.
    if (inArchive(path)) {
      toast("Can’t bookmark a location inside an archive");
      return;
    }
    if (state.locations.some((l) => l.path === path)) return;
    state.locations.push({ path, name });
    persist();
    this.refreshSidebars();
  }

  private removeFavorite(path: string): void {
    const i = state.locations.findIndex((l) => l.path === path);
    if (i < 0) return;
    state.locations.splice(i, 1);
    persist();
    this.refreshSidebars();
  }

  private moveFavorite(from: number, to: number): void {
    const arr = state.locations;
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    persist();
    this.refreshSidebars();
  }

  private refreshSidebars(): void {
    for (const v of this.views.values()) v.sidebar?.render();
  }

  /** Apply a tab's single/dual layout: toggle the class, and in single mode force
      the main pane active + refresh the sidebar. */
  private applySingle(tab: Tab): void {
    const v = this.views.get(tab.id);
    if (!v?.dual) return;
    v.dual.classList.toggle("single", !!tab.single);
    if (tab.single) {
      if (this.previewTarget) this.closePanePreview();
      tab.activePane = 0;
      this.syncPaneActive(tab);
      v.sidebar?.render();
    }
  }

  private toggleSingle(): void {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes) return; // file tabs only
    this.closePanePreview();
    tab.single = !tab.single;
    this.applySingle(tab);
    this.syncSingleBtn();
    this.renderTabstrip(); // title switches between "one" and "left - right"
    persist();
  }

  private syncSingleBtn(): void {
    const tab = state.tabs[state.activeTab];
    const isFile = !!tab?.panes;
    this.spBtn.classList.toggle("on", isFile && !!tab?.single);
    this.spBtn.classList.toggle("disabled", !isFile);
  }

  // ---- opposite-pane preview -------------------------------------------------

  /** Space with previewPane on: toggle a live preview of the browsed pane's
      cursor item in the opposite pane. Arrow keys then follow (cursorMoved). */
  private togglePanePreview(source: PaneView): void {
    if (this.previewTarget) {
      this.closePanePreview();
      return;
    }
    const tab = state.tabs[state.activeTab];
    const panes = tab?.panes ? this.views.get(tab.id)?.panes : null;
    if (!panes) return;
    const target = panes[0] === source ? panes[1] : panes[0];
    const cur = source.currentEntry();
    if (!cur) return;
    this.previewSource = source;
    this.previewTarget = target;
    target.showPreview(cur.entry, cur.dirPath);
  }

  private refreshPanePreview(): void {
    const cur = this.previewSource?.currentEntry();
    if (cur) this.previewTarget?.showPreview(cur.entry, cur.dirPath);
  }

  private closePanePreview(): void {
    this.previewTarget?.hidePreview();
    this.previewSource = null;
    this.previewTarget = null;
  }

  /** Record on the active tab which pane (if any) is currently previewing, so
      activateTab can reopen it when we come back. Call before closePanePreview. */
  private rememberPanePreview(): void {
    const tab = state.tabs[state.activeTab];
    const v = tab ? this.views.get(tab.id) : null;
    if (!v?.panes) return;
    const idx = this.previewSource ? v.panes.indexOf(this.previewSource) : -1;
    v.previewSourceIdx = idx === 0 || idx === 1 ? idx : null;
  }

  /** Reopen the newly-active tab's remembered opposite-pane preview, if it had
      one when we last left it. Call after the tab's view is active. */
  private restorePanePreview(): void {
    if (!state.settings.previewPane) return; // opposite-pane preview is off
    const tab = state.tabs[state.activeTab];
    if (tab?.kind !== "files") return;
    const v = this.views.get(tab.id);
    const idx = v?.previewSourceIdx;
    if ((idx !== 0 && idx !== 1) || !v?.panes) return;
    // Single-pane tabs preview too (the hidden pane 1 becomes the preview pane),
    // so restore them as well — only the source pane index matters here.
    const source = v.panes[idx];
    if (source.currentEntry()) this.togglePanePreview(source); // nothing open → opens
  }

  private doPreview(): void {
    const p = this.activePane();
    if (!p) return;
    // Space on a folder → compute + show its size only (no file preview).
    if (p.sizeCursorDir()) return;
    if (state.settings.previewPane) {
      this.togglePanePreview(p);
    } else {
      this.previewPane = p;
      p.previewCursor();
    }
  }

  /** ⌘1 / ⌘2: open the left/right pane's Favorites dropdown. */
  private openFavorites(index: 0 | 1): boolean {
    const panes = this.views.get(state.tabs[state.activeTab]?.id ?? -1)?.panes;
    if (!panes) return false;
    panes[index === 0 ? 1 : 0]?.closeAllPopovers(); // only one popover open at a time
    panes[index]?.openFavorites();
    return !!panes[index];
  }

  /** Alt+F1 / Alt+F2 (Windows): open the left/right pane's drive-letter picker.
      In single-pane mode there's only one visible pane, so both keys target it. */
  private openDrives(index: 0 | 1): boolean {
    const tab = state.tabs[state.activeTab];
    const panes = this.views.get(tab?.id ?? -1)?.panes;
    if (!panes) return false;
    const target = tab?.single ? tab.activePane : index;
    panes[target === 0 ? 1 : 0]?.closeAllPopovers(); // close the other pane's picker first
    panes[target]?.openDrives();
    return !!panes[target];
  }

  // ---- keyboard bindings -----------------------------------------------------

  private rebuildComboMap(): void {
    const m = new Map<string, CommandId>();
    for (const cmd of COMMANDS) {
      for (const combo of state.keybindings[cmd.id] ?? []) m.set(combo, cmd.id);
    }
    this.comboMap = m;
  }

  /** Persist + re-index + refresh the Shortcuts tab after any binding edit. */
  private afterBindingsChanged(): void {
    this.rebuildComboMap();
    for (const v of this.views.values()) v.keybindings?.sync();
    persist();
  }

  // ---- hidden files ----------------------------------------------------------

  private setHidden(v: boolean): void {
    state.settings.showHidden = v;
    this.syncEye();
    for (const view of this.views.values()) view.panes?.forEach((p) => p.rebuild(true));
    for (const view of this.views.values()) view.settings?.sync();
    persist();
  }

  toggleHidden(): void {
    this.setHidden(!state.settings.showHidden);
    toast(state.settings.showHidden ? "Hidden files shown" : "Hidden files hidden");
  }

  private syncEye(): void {
    this.eyeBtn.classList.toggle("on", state.settings.showHidden);
  }

  // ---- theme -----------------------------------------------------------------

  /** Toolbar toggle: flips between light and dark (leaving System behind). */
  private toggleTheme(): void {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    state.settings.theme = next;
    applyTheme(next);
    for (const v of this.views.values()) v.settings?.sync();
    toast(next === "dark" ? "Dark theme" : "Light theme");
    persist();
  }

  private syncThemeBtn(): void {
    const dark = effectiveTheme() === "dark";
    // Show where a click takes you: sun to go light, moon to go dark.
    this.themeBtn.innerHTML = dark ? icons.sun : icons.moon;
    this.themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }

  /** The dev-tools button only exists when the setting is enabled. */
  private syncDevBtn(): void {
    this.devBtn.hidden = !state.settings.devTools;
  }

  // ---- zoom ------------------------------------------------------------------

  private applyZoomCss(): void {
    document.documentElement.style.fontSize = `${(16 * state.zoom) / 100}px`;
  }

  setZoom(z: number, announce: boolean): void {
    state.zoom = clamp(z, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    this.applyZoomCss();
    // Row height changed — re-render all virtualized lists.
    for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
    this.fitTabTitles(); // px budget scales with root font-size
    if (announce) toast(`${state.zoom}%`);
    persist();
  }

  zoomStep(d: 1 | -1): void {
    const i = ZOOM_LEVELS.reduce(
      (best, z, j) =>
        Math.abs(z - state.zoom) < Math.abs(ZOOM_LEVELS[best] - state.zoom) ? j : best,
      0
    );
    this.setZoom(ZOOM_LEVELS[clamp(i + d, 0, ZOOM_LEVELS.length - 1)], true);
  }
}

new App().init();
