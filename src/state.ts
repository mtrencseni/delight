import { invoke } from "./ipc";
import type { Location, Settings, Tab } from "./types";

export const ZOOM_LEVELS = [50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
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
    devTools: false,
  } as Settings,
  // Global "Finder sidebar" locations, shared across panes/tabs.
  locations: [] as Location[],
};

let nextId = 1;
export function newTabId(): number {
  return nextId++;
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
      tabs: state.tabs.map((t) => ({
        kind: t.kind,
        activePane: t.activePane,
        panes:
          t.panes?.map((p) => ({
            path: p.path,
            sortKey: p.sortKey,
            sortDir: p.sortDir,
            colWidths: p.colWidths,
            viewMode: p.viewMode,
            gridSize: p.gridSize,
          })) ?? null,
      })),
    };
    invoke("save_state", { state: data }).catch(() => {});
  }, 250);
}
