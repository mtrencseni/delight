import "./styles.css";
import { invoke, onEvent } from "./ipc";
import { GRID_DEFAULT, GRID_MAX, GRID_MIN, newTabId, persist, state, ZOOM_LEVELS } from "./state";
import type { PaneState, Tab, Theme } from "./types";
import { PaneView } from "./pane";
import { initKeyboard } from "./keyboard";
import { applyTheme, effectiveTheme, onThemeChange } from "./theme";
import { toast } from "./toast";
import { icons } from "./icons";
import { buildSettingsPage, type SettingsPage } from "./settingsPage";
import { clamp } from "./format";

interface TabView {
  el: HTMLElement;
  panes: [PaneView, PaneView] | null;
  settings?: SettingsPage;
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
  views = new Map<number, TabView>();
  private previewPane: PaneView | null = null;

  async init(): Promise<void> {
    const [saved, home] = await Promise.all([
      invoke<any>("load_state").catch(() => null),
      invoke<string>("home_dir").catch(() => "/"),
    ]);
    this.home = home;
    this.restoreSettings(saved);

    // Restore saved locations; default to just the user's home.
    const savedLocs = Array.isArray(saved?.locations) ? saved.locations : null;
    state.locations =
      savedLocs
        ?.filter((l: any) => typeof l?.path === "string" && typeof l?.name === "string")
        .map((l: any) => ({ path: l.path, name: l.name })) ?? [];
    if (state.locations.length === 0) {
      state.locations = [{ path: home, name: home.split("/").filter(Boolean).pop() || "Home" }];
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

    initKeyboard({
      newTab: () => void this.newTab(),
      closeTab: () => this.closeTab(state.activeTab),
      nextTab: () => this.cycleTab(1),
      prevTab: () => this.cycleTab(-1),
      openSettings: () => this.addSettingsTab(true),
      zoomStep: (d) => this.zoomStep(d),
      zoomReset: () => this.setZoom(state.settings.defaultZoom, true),
      toggleHidden: () => this.toggleHidden(),
      switchPane: () => this.switchPane(),
      cursor: (d) => this.activePane()?.moveCursor(d),
      cursorPage: (d) => this.activePane()?.movePage(d),
      cursorHome: () => this.activePane()?.moveHome(),
      cursorEnd: () => this.activePane()?.moveEnd(),
      open: () => this.activePane()?.openCursor(),
      up: () => this.activePane()?.goUp(),
      expand: () => this.activePane()?.expandCursor(),
      collapse: () => this.activePane()?.collapseCursor(),
      preview: () => {
        const p = this.activePane();
        if (!p) return;
        this.previewPane = p;
        p.previewCursor();
      },
      devtools: () => {
        if (state.settings.devTools) void invoke("toggle_devtools").catch(() => {});
      },
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
      if (typeof s.devTools === "boolean") state.settings.devTools = s.devTools;
    }
    state.zoom = ZOOM_LEVELS.includes(saved?.zoom) ? saved.zoom : state.settings.defaultZoom;
  }

  private buildShell(): void {
    const root = document.getElementById("app")!;
    const tabbar = el("div", "tabbar");

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

    const gearBtn = el("button", "tbtn");
    gearBtn.innerHTML = icons.gear;
    gearBtn.title = "Settings (⌘,)";
    gearBtn.addEventListener("click", () => this.addSettingsTab(true));

    const spacer = el("div", "flexspace");
    // Layout: [files tabs][+] …spacer… [system tabs][theme][eye][gear]
    tabbar.append(this.tabsEl, newBtn, spacer, this.sysTabsEl, this.themeBtn, this.eyeBtn, gearBtn);
    root.append(tabbar, this.contentEl);
    this.syncEye();
    this.syncThemeBtn();
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
    return {
      activate: () => {
        tab.activePane = index;
        this.syncPaneActive(tab);
      },
      changed: () => {
        this.renderTabstrip();
        persist();
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
        mod: num(r?.colWidths?.mod, 8.5),
      },
      viewMode: r?.viewMode === "grid" ? "grid" : "list",
      gridSize: clamp(num(r?.gridSize, GRID_DEFAULT), GRID_MIN, GRID_MAX),
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
      onDevTools: (v) => {
        state.settings.devTools = v;
        // Turning it off closes the inspector if it's currently open.
        if (!v) void invoke("close_devtools").catch(() => {});
        persist();
      },
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    state.tabs.push(tab);
    this.views.set(tab.id, { el: wrap, panes: null, settings: page });
    if (activate) this.activateTab(state.tabs.length - 1);
    else this.renderTabstrip();
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
    });
  }

  cycleTab(d: 1 | -1): void {
    const n = state.tabs.length;
    this.activateTab((state.activeTab + d + n) % n);
  }

  private tabTitle(tab: Tab): string {
    if (tab.kind === "settings") return "Settings";
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
    tab.activePane = tab.activePane === 0 ? 1 : 0;
    this.syncPaneActive(tab);
    this.renderTabstrip();
    return true;
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
