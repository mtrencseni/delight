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
  /** Frontend-only: a folder's recursively-computed size (Space on a folder).
      `sizeComputing` while the walk runs, `sizeComputed` once `size` is filled. */
  sizeComputing?: boolean;
  sizeComputed?: boolean;
}

export interface Listing {
  path: string;
  name: string;
  parent: string | null;
  entries: Entry[];
  /** True inside an archive: only copy-out is allowed, everything that would
      write (rename / move / delete / new folder) is refused. */
  readOnly?: boolean;
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
  /** Where this pane last was on each drive, keyed by upper-case letter
      ("C" → "C:\\abc"). Switching drives returns you there instead of dumping
      you at the root. Per pane and per tab, so the two sides keep their own
      places. Windows-only in practice — a path with no drive letter never
      lands here. */
  driveDirs?: Record<string, string>;
}

/** A saved location shown in the pane's locations dropdown (global list). */
export interface Location {
  path: string;
  name: string;
}

/** A folder the user has entered (browsed). Kept as an LRU cache so recently /
    frequently visited folders can be highlighted in their parent. */
export interface Visited {
  path: string;
  /** Times entered (frequency). */
  count: number;
  /** Last entered, epoch ms (recency). */
  last: number;
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
  /** In chips view: expand folders into a chip too (off = folders stay plain rows). */
  folderChips: boolean;
  /** Treat `.app` bundles as launchable (open on double-click, can't enter). Off =
      Explore mode: browse them as ordinary folders. */
  launchApps: boolean;
  /** Render file content thumbnails (QuickLook) in list & icon views, like Finder. */
  previewIcons: boolean;
  /** Tint the modified time green for files changed today. */
  highlightToday: boolean;
  /** Share of the two-pane area given to the LEFT pane, 0..1. Drag the divider
      between the panes to change it; double-click the divider to reset. Global
      rather than per-tab, like the column widths — panes whose proportions
      disagree make the eye re-parse the layout on every glance across. */
  splitRatio: number;
  /** Width, in rem, of the Favorites sidebar in single-pane mode. */
  sidebarWidth: number;
  /** Alternating row background colors (zebra striping) in list & chips views. */
  stripedRows: boolean;
  /** Show a proportional data bar behind file sizes. */
  sizeBars: boolean;
  /** Scale the size bars logarithmically (with decade gridlines). */
  sizeBarLog: boolean;
  /** Space shows a live preview in the opposite pane (vs a Quick Look window). */
  previewPane: boolean;
  /** QuickLook thumbnail resolution for the opposite-pane preview (px). */
  previewSize: number;
  /** Max bytes read for the read-only code preview (rest is truncated). */
  codePreviewBytes: number;
  /** Show a Created-time column in list view. */
  showCreated: boolean;
  /** Show a Permissions column in list view. */
  showPermissions: boolean;
  /** Case transform applied to all displayed names/extensions. */
  nameCase: "original" | "lower" | "upper";
  /** Slash style shown in the path bar and tab titles: the OS native separator,
      always forward, or always back. Display-only — real paths are unaffected. */
  pathSep: "system" | "/" | "\\";
  /** Group folders above files (Norton Commander) vs sorting them inline with
      files by the active column (Finder). */
  foldersOnTop: boolean;
  /** How many recently-entered folders to remember (0 disables the highlight). */
  visitedCacheSize: number;
  /** Keep both panes in a tab sorted by the same column/direction. */
  linkedSort: boolean;
  /** Ask before copy / move / delete operations. */
  confirmOps: boolean;
  /** Hold the file-operation progress dialog back this many ms, so quick ops
      never flash it. 0 = show it immediately. */
  progressDelayMs: number;
  /** ⌘F quick-search: match names that START with the query, or contain it
      anywhere. Prefix is the default — it's what typing a name usually means. */
  findMatch: "prefix" | "anywhere";
  /** External editor launched by F4 (the Buffers executable). Empty ⇒ F4 asks to
      set it. Path to buffers.exe on Windows / the Buffers binary elsewhere. */
  editorPath: string;
  /** Enable the Web Inspector (⌥⌘I). */
  devTools: boolean;
}

export type TabKind = "files" | "settings" | "keybindings";

export interface Tab {
  id: number;
  kind: TabKind;
  activePane: 0 | 1;
  panes: [PaneState, PaneState] | null;
  /** Single-pane mode: a fixed favorites sidebar + one browsing pane (the right
      pane only appears while previewing). Per-tab. */
  single?: boolean;
}
