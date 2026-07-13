import { invoke } from "./ipc";
import { COL_KEYS, type ColKey, type Location, type Settings, type Tab } from "./types";

export const ZOOM_LEVELS = [50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
export const PREVIEW_SIZES = [512, 1024, 2048];
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
    sizeBars: true,
    sizeBarLog: false,
    previewPane: true,
    previewSize: 1024,
    showCreated: false,
    showPermissions: false,
    nameCase: "original",
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
};

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
