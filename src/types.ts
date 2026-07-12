export interface Entry {
  name: string;
  stem: string;
  ext: string | null;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number | null;
  createdMs: number | null;
  permissions: string | null;
  hidden: boolean;
}

export interface Listing {
  path: string;
  name: string;
  parent: string | null;
  entries: Entry[];
}

export type SortKey = "name" | "ext" | "size" | "created" | "modified";
export type SortDir = 1 | -1;

/** Identity of a list-view column (used for order + widths). */
export type ColKey = "name" | "ext" | "size" | "created" | "perms" | "mod";
export const COL_KEYS: ColKey[] = ["name", "ext", "size", "created", "perms", "mod"];

export interface ColWidths {
  ext: number;
  size: number;
  created: number;
  perms: number;
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
  permissions: string | null;
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
  /** Per-pane column order (used only when column order is not linked). */
  colOrder?: ColKey[];
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
  /** In chips view: 3× taller expanded chip with a big preview + 2 rows of details. */
  bigChips: boolean;
  /** Render file content thumbnails (QuickLook) in list & icon views, like Finder. */
  previewIcons: boolean;
  /** Tint the modified time green for files changed today. */
  highlightToday: boolean;
  /** Show a proportional data bar behind file sizes. */
  sizeBars: boolean;
  /** Scale the size bars logarithmically (with decade gridlines). */
  sizeBarLog: boolean;
  /** Space shows a live preview in the opposite pane (vs a Quick Look window). */
  previewPane: boolean;
  /** QuickLook thumbnail resolution for the opposite-pane preview (px). */
  previewSize: number;
  /** Show a Created-time column in list view. */
  showCreated: boolean;
  /** Show a Permissions column in list view. */
  showPermissions: boolean;
  /** Case transform applied to all displayed names/extensions. */
  nameCase: "original" | "lower" | "upper";
  /** Keep both panes in a tab sorted by the same column/direction. */
  linkedSort: boolean;
  /** Enable the Web Inspector (⌥⌘I). */
  devTools: boolean;
}

export type TabKind = "files" | "settings" | "keybindings";

export interface Tab {
  id: number;
  kind: TabKind;
  activePane: 0 | 1;
  panes: [PaneState, PaneState] | null;
}
