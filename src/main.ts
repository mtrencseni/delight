import "./styles.css";
import { invoke, isTauri, onEvent } from "./ipc";
import { GRID_DEFAULT, GRID_MAX, GRID_MIN, newTabId, normalizeColumnOrder, persist, PREVIEW_SIZES, state, ZOOM_LEVELS } from "./state";
import type { PaneState, SortDir, SortKey, Tab, Theme } from "./types";
import { PaneView } from "./pane";
import { initKeyboard } from "./keyboard";
import { COMMANDS, mergeKeybindings, type CommandId } from "./commands";
import { applyTheme, effectiveTheme, onThemeChange } from "./theme";
import { toast } from "./toast";
import { icons } from "./icons";
import { buildSettingsPage, type SettingsPage } from "./settingsPage";
import { buildKeybindingsPage, type KeybindingsPage } from "./keybindingsPage";
import { clamp } from "./format";

interface TabView {
  el: HTMLElement;
  panes: [PaneView, PaneView] | null;
  settings?: SettingsPage;
  keybindings?: KeybindingsPage;
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
  views = new Map<number, TabView>();
  /** Native Quick Look: the pane whose cursor the QL panel is following. */
  private previewPane: PaneView | null = null;
  /** In-pane preview: the browsed (source) pane and the pane showing the preview. */
  private previewSource: PaneView | null = null;
  private previewTarget: PaneView | null = null;
  /** Combo string → command id, rebuilt whenever bindings change. */
  private comboMap = new Map<string, CommandId>();
  private commandHandlers: Record<CommandId, () => boolean | void> = {} as any;

  async init(): Promise<void> {
    const [saved, home] = await Promise.all([
      invoke<any>("load_state").catch(() => null),
      invoke<string>("home_dir").catch(() => "/"),
    ]);
    this.home = home;
    this.restoreSettings(saved);
    state.keybindings = mergeKeybindings(saved?.keybindings);
    state.columnOrder = normalizeColumnOrder(saved?.columnOrder);

    // Restore saved locations; default to just the user's home.
    const savedLocs = Array.isArray(saved?.locations) ? saved.locations : null;
    state.locations =
      savedLocs
        ?.filter((l: any) => typeof l?.path === "string" && typeof l?.name === "string")
        .map((l: any) => ({ path: l.path, name: l.name })) ?? [];
    if (state.locations.length === 0) {
      state.locations = [{ path: home, name: home.split("/").filter(Boolean).pop() || "Home" }];
    }

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
              t?.activePane === 1 ? 1 : 0
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
      openSettings: () => this.addSettingsTab(true),
      switchPane: () => this.switchPane(),
      cursorUp: () => this.activePane()?.moveCursor(-1),
      cursorDown: () => this.activePane()?.moveCursor(1),
      expand: () => this.activePane()?.expandCursor(),
      collapse: () => this.activePane()?.collapseCursor(),
      pageUp: () => this.activePane()?.movePage(-1),
      pageDown: () => this.activePane()?.movePage(1),
      cursorHome: () => this.activePane()?.moveHome(),
      cursorEnd: () => this.activePane()?.moveEnd(),
      open: () => this.activePane()?.openCursor(),
      up: () => this.activePane()?.goUp(),
      selectUp: () => this.activePane()?.extendCursor(-1),
      selectDown: () => this.activePane()?.extendCursor(1),
      selectAll: () => this.activePane()?.selectAll(),
      sortName: () => this.activePane()?.cycleSort("name"),
      sortExt: () => this.activePane()?.cycleSort("ext"),
      sortSize: () => this.activePane()?.cycleSort("size"),
      sortCreated: () => this.activePane()?.cycleSort("created"),
      sortModified: () => this.activePane()?.cycleSort("modified"),
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
    };
    this.rebuildComboMap();
    initKeyboard({
      lookup: () => this.comboMap,
      run: (id) => this.commandHandlers[id]?.(),
    });

    // Quick Look reports its current item as the user arrows; follow it.
    onEvent<number>("ql-index", (idx) => this.previewPane?.applyPreviewIndex(idx));
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
      if (typeof s.highlightToday === "boolean") state.settings.highlightToday = s.highlightToday;
      if (typeof s.sizeBars === "boolean") state.settings.sizeBars = s.sizeBars;
      if (typeof s.sizeBarLog === "boolean") state.settings.sizeBarLog = s.sizeBarLog;
      if (typeof s.previewPane === "boolean") state.settings.previewPane = s.previewPane;
      if (PREVIEW_SIZES.includes(s.previewSize)) state.settings.previewSize = s.previewSize;
      if (typeof s.showCreated === "boolean") state.settings.showCreated = s.showCreated;
      if (typeof s.showPermissions === "boolean") state.settings.showPermissions = s.showPermissions;
      if (["original", "lower", "upper"].includes(s.nameCase)) state.settings.nameCase = s.nameCase;
      if (typeof s.linkedSort === "boolean") state.settings.linkedSort = s.linkedSort;
      if (typeof s.linkedColumns === "boolean") state.settings.linkedColumns = s.linkedColumns;
      if (typeof s.devTools === "boolean") state.settings.devTools = s.devTools;
    }
    state.zoom = ZOOM_LEVELS.includes(saved?.zoom) ? saved.zoom : state.settings.defaultZoom;
  }

  private buildShell(): void {
    const root = document.getElementById("app")!;
    // Native window: the tab bar doubles as the OS title bar (traffic lights
    // overlaid top-left). The class enables the left inset; the browser
    // preview stays a normal full-width bar.
    if (isTauri) document.documentElement.classList.add("native");
    const tabbar = el("div", "tabbar");
    tabbar.setAttribute("data-tauri-drag-region", "");

    const newBtn = el("button", "tbtn");
    newBtn.innerHTML = icons.plus;
    newBtn.title = "New tab (⌘T)";
    newBtn.addEventListener("click", () => void this.newTab());

    this.eyeBtn.innerHTML = icons.eye;
    this.eyeBtn.title = "Show hidden files (⌘⇧.)";
    this.eyeBtn.addEventListener("click", () => this.toggleHidden());

    this.themeBtn.addEventListener("click", () => this.toggleTheme());
    // Keep the icon in sync when the OS appearance flips while in System mode.
    onThemeChange(() => this.syncThemeBtn());

    this.devBtn.innerHTML = icons.code;
    this.devBtn.title = "Developer tools (⌥⌘I)";
    this.devBtn.addEventListener("click", () => void invoke("toggle_devtools").catch(() => {}));

    const gearBtn = el("button", "tbtn");
    gearBtn.innerHTML = icons.gear;
    gearBtn.title = "Settings (⌘,)";
    gearBtn.addEventListener("click", () => this.addSettingsTab(true));

    const spacer = el("div", "flexspace");
    spacer.setAttribute("data-tauri-drag-region", ""); // main window-drag zone
    // Layout: [files tabs][+] …spacer… [system tabs][theme][eye][dev][gear]
    tabbar.append(this.tabsEl, newBtn, spacer, this.sysTabsEl, this.themeBtn, this.eyeBtn, this.devBtn, gearBtn);
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
        // Navigating/sorting the browsed pane invalidates an open preview.
        if (this.previewSource && pane() === this.previewSource) this.closePanePreview();
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
      addLocation: (path: string, name: string) => {
        if (!state.locations.some((l) => l.path === path)) {
          state.locations.push({ path, name });
          persist();
        }
      },
      removeLocation: (path: string) => {
        const i = state.locations.findIndex((l) => l.path === path);
        if (i >= 0) {
          state.locations.splice(i, 1);
          persist();
        }
      },
      moveLocation: (from: number, to: number) => {
        const arr = state.locations;
        if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        persist();
      },
    };
  }

  private async addFilesTab(
    paths: [string, string],
    restored?: any[],
    activePane: 0 | 1 = 0
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
      viewMode: r?.viewMode === "grid" ? "grid" : "list",
      gridSize: clamp(num(r?.gridSize, GRID_DEFAULT), GRID_MIN, GRID_MAX),
      colOrder: Array.isArray(r?.colOrder) ? normalizeColumnOrder(r.colOrder) : undefined,
    });
    const tab: Tab = {
      id: newTabId(),
      kind: "files",
      activePane,
      panes: [mk(paths[0], restored?.[0]), mk(paths[1], restored?.[1])],
    };
    const wrap = el("div", "tabview");
    const dual = el("div", "dual");
    const pv0 = new PaneView(tab.panes![0], this.paneHost(tab, 0));
    const pv1 = new PaneView(tab.panes![1], this.paneHost(tab, 1));
    dual.append(pv0.el, pv1.el);
    wrap.append(dual);
    this.contentEl.append(wrap);

    state.tabs.push(tab);
    this.views.set(tab.id, { el: wrap, panes: [pv0, pv1] });
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
      onHighlightToday: (v) => {
        state.settings.highlightToday = v;
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
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
        for (const view of this.views.values()) view.panes?.forEach((p) => p.renderRows());
        persist();
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
      onLinkedColumns: (v) => {
        state.settings.linkedColumns = v;
        // Switching to shared adopts the current global order everywhere.
        for (const view of this.views.values()) view.panes?.forEach((p) => p.refreshColumns());
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
    this.closePanePreview(); // a preview belongs to the tab it was opened in
    state.activeTab = clamp(i, 0, state.tabs.length - 1);
    this.applyActiveTab();
    this.syncActiveTabClass();
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
  }

  cycleTab(d: 1 | -1): void {
    const n = state.tabs.length;
    this.activateTab((state.activeTab + d + n) % n);
  }

  private tabTitle(tab: Tab): string {
    if (tab.kind === "settings") return "Settings";
    if (tab.kind === "keybindings") return "Shortcuts";
    const name = (p: PaneState) => p.listing?.name || p.path || "—";
    const title = `${name(tab.panes![0])} - ${name(tab.panes![1])}`;
    return state.settings.lowercaseTabs ? title.toLowerCase() : title;
  }

  private buildTabEl(tab: Tab): HTMLElement {
    const t = el("div", "tab" + (state.tabs[state.activeTab]?.id === tab.id ? " active" : ""));
    t.dataset.tabId = String(tab.id);
    const title = el("span", "tabtitle");
    title.textContent = this.tabTitle(tab);
    const close = el("span", "tabclose");
    close.innerHTML = icons.close;
    close.title = "Close tab (⌘W)";
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

  switchPane(): boolean {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes) return false;
    this.closePanePreview(); // the opposite pane is about to become active
    tab.activePane = tab.activePane === 0 ? 1 : 0;
    this.syncPaneActive(tab);
    this.renderTabstrip();
    return true;
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

  private doPreview(): void {
    const p = this.activePane();
    if (!p) return;
    if (state.settings.previewPane) {
      this.togglePanePreview(p);
    } else {
      this.previewPane = p;
      p.previewCursor();
    }
  }

  /** ⌘1 / ⌘2: open the left/right pane's Favorites dropdown. */
  private openFavorites(index: 0 | 1): boolean {
    const tab = state.tabs[state.activeTab];
    if (!tab?.panes) return false;
    const p = this.views.get(tab.id)?.panes?.[index];
    if (!p) return false;
    p.openFavorites();
    return true;
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
