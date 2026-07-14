import { invoke } from "./ipc";
import { COL_KEYS, type ColKey, type Location, type Settings, type Tab, type Visited } from "./types";

export const ZOOM_LEVELS = [50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
export const PREVIEW_SIZES = [512, 1024, 2048];
/** Cache sizes offered for the "recent folders" highlight. */
export const VISITED_SIZES = [50, 100, 200, 500];
/** Byte caps offered for the read-only code preview (10K default → 10M). */
export const CODE_PREVIEW_BYTES = [10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024];
export const GRID_MIN = 48;
export const GRID_MAX = 160;
export const GRID_DEFAULT = 80;

export const state = {
  tabs: [] as Tab[],
  activeTab: 0,
  zoom: 100,
  settings: {
    theme: "system",
    showHidden: false,
    defaultZoom: 100,
    lowercaseTabs: false,
    systemIcons: false,
    chipCards: false,
    bigChips: true,
    folderChips: true,
    launchApps: true,
    previewIcons: false,
    highlightToday: true,
    stripedRows: true,
    sizeBars: true,
    sizeBarLog: false,
    previewPane: true,
    previewSize: 1024,
    codePreviewBytes: 10 * 1024,
    showCreated: false,
    showPermissions: false,
    nameCase: "original",
    foldersOnTop: true,
    visitedCacheSize: 100,
    linkedSort: true,
    devTools: false,
  } as Settings,
  // One global list-view column spec (order + widths), shared across every
  // pane and tab: resizing or reordering in one place updates everywhere.
  columnOrder: [...COL_KEYS] as ColKey[],
  columnWidths: { ext: 3.25, size: 5.25, created: 8.5, perms: 6, mod: 8.5 },
  // Global "Finder sidebar" locations, shared across panes/tabs.
  locations: [] as Location[],
  // Effective keyboard bindings: command id -> combo strings. Seeded from
  // defaults at startup (see main.ts), then user-editable in the Shortcuts tab.
  keybindings: {} as Record<string, string[]>,
  // Whether we've already offered the Dropbox folder as a default favorite
  // (once only, so removing it sticks).
  dropboxSeeded: false,
  // LRU cache of folders the user has entered (for the "recent folders"
  // highlight). `visitedPaths` mirrors it as a Set for O(1) render-time lookup.
  visited: [] as Visited[],
  visitedPaths: new Set<string>(),
};

/** Rebuild the fast membership Set from the visited array (after load/edit). */
export function rebuildVisitedIndex(): void {
  state.visitedPaths = new Set(state.visited.map((v) => v.path));
}

/** Record that the user entered `path` (browsed its contents). Bumps recency +
    frequency and evicts the least-recently-used entry beyond the cache size. */
export function recordVisit(path: string): void {
  const cap = state.settings.visitedCacheSize;
  if (cap <= 0) {
    if (state.visited.length) clearVisited();
    return;
  }
  const now = Date.now();
  const existing = state.visited.find((v) => v.path === path);
  if (existing) {
    existing.count++;
    existing.last = now;
  } else {
    state.visited.push({ path, count: 1, last: now });
    state.visitedPaths.add(path);
  }
  if (state.visited.length > cap) {
    state.visited.sort((a, b) => a.last - b.last); // oldest first
    for (const v of state.visited.splice(0, state.visited.length - cap)) state.visitedPaths.delete(v.path);
  }
  persist();
}

/** Empty the recent-folders cache. */
export function clearVisited(): void {
  state.visited = [];
  state.visitedPaths = new Set();
  persist();
}

let nextId = 1;
export function newTabId(): number {
  return nextId++;
}

/** Sanitize a saved column order: keep valid keys in order, append any missing. */
export function normalizeColumnOrder(saved: unknown): ColKey[] {
  const seen = new Set<ColKey>();
  const out: ColKey[] = [];
  if (Array.isArray(saved)) {
    for (const k of saved) {
      if (COL_KEYS.includes(k as ColKey) && !seen.has(k as ColKey)) {
        seen.add(k as ColKey);
        out.push(k as ColKey);
      }
    }
  }
  for (const k of COL_KEYS) if (!seen.has(k)) out.push(k);
  return out;
}

let saveTimer: number | undefined;

/** Debounced write of everything worth surviving a restart. */
export function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const data = {
      settings: state.settings,
      zoom: state.zoom,
      activeTab: state.activeTab,
      locations: state.locations,
      keybindings: state.keybindings,
      columnOrder: state.columnOrder,
      columnWidths: state.columnWidths,
      dropboxSeeded: state.dropboxSeeded,
      visited: state.visited,
      tabs: state.tabs.map((t) => ({
        kind: t.kind,
        activePane: t.activePane,
        single: t.single,
        panes:
          t.panes?.map((p) => ({
            path: p.path,
            sortKey: p.sortKey,
            sortDir: p.sortDir,
            colWidths: p.colWidths,
            viewMode: p.viewMode,
            gridSize: p.gridSize,
            colOrder: p.colOrder,
          })) ?? null,
      })),
    };
    invoke("save_state", { state: data }).catch(() => {});
  }, 250);
}
