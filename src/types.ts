export interface Entry {
  name: string;
  stem: string;
  ext: string | null;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number | null;
  hidden: boolean;
}

export interface Listing {
  path: string;
  name: string;
  parent: string | null;
  entries: Entry[];
}

export type SortKey = "name" | "ext" | "size" | "modified";
export type SortDir = 1 | -1;

export interface ColWidths {
  ext: number;
  size: number;
  mod: number;
}

export type ViewMode = "list" | "grid" | "chips";

export interface ChildEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  ext: string | null;
}

export interface Details {
  createdMs: number | null;
  owner: string | null;
  appName: string | null;
  appPath: string | null;
  dirCount: number | null;
  children: ChildEntry[];
}

export interface PaneState {
  path: string;
  listing: Listing | null;
  sortKey: SortKey;
  sortDir: SortDir;
  cursor: number;
  /** Column widths in rem so they scale with zoom. */
  colWidths: ColWidths;
  viewMode: ViewMode;
  /** Icon tile size (px) in grid view. */
  gridSize: number;
}

/** A saved location shown in the pane's locations dropdown (global list). */
export interface Location {
  path: string;
  name: string;
}

export type Theme = "light" | "dark" | "system";

export interface Settings {
  theme: Theme;
  showHidden: boolean;
  defaultZoom: number;
  lowercaseTabs: boolean;
  systemIcons: boolean;
  /** In chips view: render every row as a card (vs a compact accordion). */
  chipCards: boolean;
}

export type TabKind = "files" | "settings";

export interface Tab {
  id: number;
  kind: TabKind;
  activePane: 0 | 1;
  panes: [PaneState, PaneState] | null;
}
