import type { Settings, Theme } from "./types";
import { CODE_PREVIEW_BYTES, hint, PREVIEW_SIZES, VISITED_SIZES, ZOOM_LEVELS } from "./state";
import { icons } from "./icons";
import { isMac } from "./platform";

export interface SettingsHooks {
  get(): Settings;
  onTheme(t: Theme): void;
  onHidden(v: boolean): void;
  onDefaultZoom(z: number): void;
  onLowercaseTabs(v: boolean): void;
  onSystemIcons(v: boolean): void;
  onChipCards(v: boolean): void;
  onBigChips(v: boolean): void;
  onFolderChips(v: boolean): void;
  onLaunchApps(v: boolean): void;
  onPreviewIcons(v: boolean): void;
  onHighlightToday(v: boolean): void;
  onStripedRows(v: boolean): void;
  onSizeBars(v: boolean): void;
  onSizeBarLog(v: boolean): void;
  onPreviewPane(v: boolean): void;
  onPreviewSize(n: number): void;
  onCodePreviewBytes(n: number): void;
  onShowCreated(v: boolean): void;
  onShowPermissions(v: boolean): void;
  onNameCase(c: "original" | "lower" | "upper"): void;
  onPathSep(s: "system" | "/" | "\\"): void;
  onFoldersOnTop(v: boolean): void;
  onVisitedCacheSize(n: number): void;
  onClearVisited(): void;
  onLinkedSort(v: boolean): void;
  onConfirmOps(v: boolean): void;
  onOpenKeybindings(): void;
  onDevTools(v: boolean): void;
}

export interface SettingsPage {
  el: HTMLElement;
  /** Re-read state into the controls (e.g. after Cmd+Shift+. elsewhere). */
  sync(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label: string, hint: string, control: HTMLElement): HTMLElement {
  const r = el("div", "setrow");
  const left = el("div", "setlabel");
  left.append(el("div", "setname", label), el("div", "sethint", hint));
  r.append(left, control);
  return r;
}

export function buildSettingsPage(hooks: SettingsHooks): SettingsPage {
  const root = el("div", "settings");
  const inner = el("div", "settings-inner");
  root.append(inner);
  inner.append(el("h1", "", "Settings"));

  // Sections are just (title, rows...) — adding future sections is one call.
  const section = (title: string, ...rows: HTMLElement[]) => {
    const s = el("section", "setsection");
    s.append(el("h2", "", title), ...rows);
    inner.append(s);
  };

  // Theme segmented control
  const seg = el("div", "seg");
  const themeBtns = new Map<Theme, HTMLButtonElement>();
  for (const t of ["light", "dark", "system"] as Theme[]) {
    const b = el("button", "", t[0].toUpperCase() + t.slice(1));
    b.addEventListener("click", () => {
      hooks.onTheme(t);
      sync();
    });
    themeBtns.set(t, b);
    seg.append(b);
  }

  // Preview resolution segmented control (512 / 1024 / 2048 px).
  const sizeSeg = el("div", "seg");
  const sizeBtns = new Map<number, HTMLButtonElement>();
  for (const px of PREVIEW_SIZES) {
    const b = el("button", "", String(px));
    b.addEventListener("click", () => {
      hooks.onPreviewSize(px);
      sync();
    });
    sizeBtns.set(px, b);
    sizeSeg.append(b);
  }

  // Code-preview byte cap segmented control (10K / 100K / 1M / 10M).
  const byteLabel = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))}M` : `${Math.round(n / 1024)}K`);
  const codeBytesSeg = el("div", "seg");
  const codeBytesBtns = new Map<number, HTMLButtonElement>();
  for (const n of CODE_PREVIEW_BYTES) {
    const b = el("button", "", byteLabel(n));
    b.addEventListener("click", () => {
      hooks.onCodePreviewBytes(n);
      sync();
    });
    codeBytesBtns.set(n, b);
    codeBytesSeg.append(b);
  }

  // Recent-folders cache size (50 / 100 / 200 / 500) + a Clear button.
  const visitedSeg = el("div", "seg");
  const visitedBtns = new Map<number, HTMLButtonElement>();
  for (const n of VISITED_SIZES) {
    const b = el("button", "", String(n));
    b.addEventListener("click", () => {
      hooks.onVisitedCacheSize(n);
      sync();
    });
    visitedBtns.set(n, b);
    visitedSeg.append(b);
  }
  const clearVisitedBtn = el("button", "textbtn", "Clear");
  clearVisitedBtn.addEventListener("click", () => hooks.onClearVisited());

  // Toggle switch factory: reads its value and applies a change via callbacks.
  const makeSwitch = (read: () => boolean, write: (v: boolean) => void) => {
    const s = el("button", "switch");
    s.setAttribute("role", "switch");
    s.append(el("span", "knob"));
    s.addEventListener("click", () => {
      write(!read());
      sync();
    });
    return s;
  };
  const hiddenSw = makeSwitch(() => hooks.get().showHidden, hooks.onHidden);
  const lowerSw = makeSwitch(() => hooks.get().lowercaseTabs, hooks.onLowercaseTabs);
  const sysIconSw = makeSwitch(() => hooks.get().systemIcons, hooks.onSystemIcons);
  const previewIconSw = makeSwitch(() => hooks.get().previewIcons, hooks.onPreviewIcons);
  const launchAppsSw = makeSwitch(() => hooks.get().launchApps, hooks.onLaunchApps);
  const createdColSw = makeSwitch(() => hooks.get().showCreated, hooks.onShowCreated);
  const permsColSw = makeSwitch(() => hooks.get().showPermissions, hooks.onShowPermissions);
  const foldersTopSw = makeSwitch(() => hooks.get().foldersOnTop, hooks.onFoldersOnTop);
  const linkedSortSw = makeSwitch(() => hooks.get().linkedSort, hooks.onLinkedSort);
  const confirmOpsSw = makeSwitch(() => hooks.get().confirmOps, hooks.onConfirmOps);

  // Item-case segmented control (original / lowercase / uppercase).
  const caseSeg = el("div", "seg");
  const caseBtns = new Map<"original" | "lower" | "upper", HTMLButtonElement>();
  for (const [val, label] of [
    ["original", "Original"],
    ["lower", "lowercase"],
    ["upper", "UPPERCASE"],
  ] as ["original" | "lower" | "upper", string][]) {
    const b = el("button", "", label);
    b.addEventListener("click", () => {
      hooks.onNameCase(val);
      sync();
    });
    caseBtns.set(val, b);
    caseSeg.append(b);
  }

  // Path-separator segmented control (system / forward / back).
  const sepSeg = el("div", "seg");
  const sepBtns = new Map<"system" | "/" | "\\", HTMLButtonElement>();
  for (const [val, label] of [
    ["system", "System"],
    ["/", "/"],
    ["\\", "\\"],
  ] as ["system" | "/" | "\\", string][]) {
    const b = el("button", "", label);
    b.addEventListener("click", () => {
      hooks.onPathSep(val);
      sync();
    });
    sepBtns.set(val, b);
    sepSeg.append(b);
  }
  const chipCardsSw = makeSwitch(() => hooks.get().chipCards, hooks.onChipCards);
  const bigChipsSw = makeSwitch(() => hooks.get().bigChips, hooks.onBigChips);
  const folderChipsSw = makeSwitch(() => hooks.get().folderChips, hooks.onFolderChips);
  const todaySw = makeSwitch(() => hooks.get().highlightToday, hooks.onHighlightToday);
  const stripedSw = makeSwitch(() => hooks.get().stripedRows, hooks.onStripedRows);
  const sizeBarsSw = makeSwitch(() => hooks.get().sizeBars, hooks.onSizeBars);
  const sizeBarLogSw = makeSwitch(() => hooks.get().sizeBarLog, hooks.onSizeBarLog);
  const previewPaneSw = makeSwitch(() => hooks.get().previewPane, hooks.onPreviewPane);
  const devToolsSw = makeSwitch(() => hooks.get().devTools, hooks.onDevTools);

  // Default zoom stepper
  const stepper = el("div", "stepper");
  const minus = el("button", "stepbtn");
  minus.innerHTML = "&minus;";
  const val = el("span", "stepval");
  const plus = el("button", "stepbtn");
  plus.innerHTML = icons.plus;
  const stepZoom = (d: 1 | -1) => {
    const cur = hooks.get().defaultZoom;
    const i = ZOOM_LEVELS.reduce(
      (best, z, j) => (Math.abs(z - cur) < Math.abs(ZOOM_LEVELS[best] - cur) ? j : best),
      0
    );
    const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + d))];
    hooks.onDefaultZoom(next);
    sync();
  };
  minus.addEventListener("click", () => stepZoom(-1));
  plus.addEventListener("click", () => stepZoom(1));
  stepper.append(minus, val, plus);

  section(
    "Appearance",
    row("Theme", `Light, dark, or follow ${isMac ? "macOS" : "the system"}`, seg),
    row("Show hidden files", `Dotfiles in both panes — ${hint("toggleHidden")}`, hiddenSw),
    row("Default zoom", `Startup zoom level — ${hint("zoomReset")} returns here`, stepper)
  );

  section(
    "Tabs",
    row("Lowercase tab titles", "Show tab names in all lowercase", lowerSw)
  );

  section(
    "Files",
    row("System file icons", "Use macOS icons instead of Delight's vector set", sysIconSw),
    row("Preview icons", "Show file content thumbnails in list & icon views, like Finder", previewIconSw),
    row("Launch apps", "Double-click a .app to launch it (can't enter). Off = browse it as a folder", launchAppsSw),
    row("Preview in opposite pane", "Space previews the file in the other pane instead of a Quick Look window", previewPaneSw),
    row("Preview resolution", "Thumbnail size (px) for the opposite-pane preview", sizeSeg),
    row("Code preview size", "How much of a text file to load into the read-only editor preview", codeBytesSeg),
    row("Alternating row colors", "Zebra-stripe every other row in list and chips views", stripedSw),
    row("Recent folders", "Highlight folders you've recently entered when browsing their parent (←/→ jumps between them)", visitedSeg),
    row("Clear recent folders", "Forget every remembered folder", clearVisitedBtn),
    row("Highlight recent files", "Green modified time for today, paler for yesterday", todaySw),
    row("Size bars", "Proportional data bar behind file sizes", sizeBarsSw),
    row("Logarithmic size bars", "Log scale with decade gridlines (10 KB, 100 KB, …)", sizeBarLogSw),
    row("Created column", "Show a Created-time column in list view", createdColSw),
    row("Permissions column", "Show a Permissions column in list view", permsColSw),
    row("Item case", "Display all names and extensions in this case", caseSeg),
    row("Path separator", "Slashes in the path bar and tab titles — the OS default, or force / or \\", sepSeg)
  );

  section(
    "Sorting",
    row("Folders on top", "Group folders above files (Norton Commander) instead of sorting them inline (Finder)", foldersTopSw),
    row("Link both panes", "Sort both panes in a tab by the same column", linkedSortSw)
  );

  section(
    "File operations",
    row("Confirm before acting", "Ask before Copy (5), Move (6) and Move to Trash (8)", confirmOpsSw)
  );

  const kbBtn = el("button", "linkbtn");
  kbBtn.innerHTML = `${icons.keyboard}<span>Configure shortcuts</span>${icons.chevron}`;
  kbBtn.addEventListener("click", () => hooks.onOpenKeybindings());

  section(
    "Keyboard",
    row("Keyboard shortcuts", "View and customize every key binding", kbBtn)
  );

  section(
    "Chips view",
    row("Card rows", "Show every row as a card instead of a compact accordion", chipCardsSw),
    row("Bigger chips", "3× taller expanded chip with a large preview and two rows of details", bigChipsSw),
    row("Chips for folders", "Expand folders into a detail chip too — off keeps them as plain rows", folderChipsSw)
  );

  section(
    "Advanced",
    row("Enable developer tools", `Toggle the Web Inspector with ${hint("devtools")}`, devToolsSw)
  );

  const setSwitch = (s: HTMLElement, on: boolean) => {
    s.classList.toggle("on", on);
    s.setAttribute("aria-checked", String(on));
  };

  function sync(): void {
    const s = hooks.get();
    for (const [t, b] of themeBtns) b.classList.toggle("on", s.theme === t);
    for (const [px, b] of sizeBtns) b.classList.toggle("on", s.previewSize === px);
    for (const [n, b] of codeBytesBtns) b.classList.toggle("on", s.codePreviewBytes === n);
    for (const [n, b] of visitedBtns) b.classList.toggle("on", s.visitedCacheSize === n);
    setSwitch(hiddenSw, s.showHidden);
    setSwitch(lowerSw, s.lowercaseTabs);
    setSwitch(sysIconSw, s.systemIcons);
    setSwitch(previewIconSw, s.previewIcons);
    setSwitch(launchAppsSw, s.launchApps);
    setSwitch(chipCardsSw, s.chipCards);
    setSwitch(bigChipsSw, s.bigChips);
    setSwitch(folderChipsSw, s.folderChips);
    setSwitch(todaySw, s.highlightToday);
    setSwitch(stripedSw, s.stripedRows);
    setSwitch(sizeBarsSw, s.sizeBars);
    setSwitch(sizeBarLogSw, s.sizeBarLog);
    setSwitch(previewPaneSw, s.previewPane);
    setSwitch(createdColSw, s.showCreated);
    setSwitch(permsColSw, s.showPermissions);
    setSwitch(foldersTopSw, s.foldersOnTop);
    setSwitch(linkedSortSw, s.linkedSort);
    setSwitch(confirmOpsSw, s.confirmOps);
    for (const [val, b] of caseBtns) b.classList.toggle("on", s.nameCase === val);
    for (const [val, b] of sepBtns) b.classList.toggle("on", s.pathSep === val);
    setSwitch(devToolsSw, s.devTools);
    val.textContent = `${s.defaultZoom}%`;
  }
  sync();

  return { el: root, sync };
}
