# CLAUDE.md — working on Delight Commander

Context for resuming development. Read this, then [SPEC.md](SPEC.md) for the
original intent. User-facing overview is in [README.md](README.md).

## What this is

**Delight Commander** ("Delight") — a Total Commander–style dual-pane file
manager. **v0.1: macOS, strictly read-only** (never mutates the user's files;
only writes its own settings). Cross-platform (Windows/Linux) is planned — the
code is written to make that a fill-in-the-blanks job, not a rewrite.

**Design principle — "delight":** snappy, keyboard-first, no jank, subtle
~120ms animations, its own single design on all platforms (NOT native
emulation). All icons are inline SVG; bundled Inter font; everything scales via
root `rem` so zoom Just Works. If a feature can't feel good, cut it.

## Stack & commands

- **Tauri 2** (Rust backend + WKWebView) + **vanilla TypeScript / Vite** + **pnpm**.
- All filesystem access is via Rust `#[tauri::command]`s; the webview never
  touches the disk. Commands are async and must not block the UI.

```sh
pnpm install
pnpm tauri dev            # native app + HMR
pnpm dev                  # browser-only against src/mock.ts (no native shell)
pnpm tauri build          # → src-tauri/target/release/bundle/macos/Delight.app
./node_modules/.bin/tsc   # typecheck (also: pnpm build runs tsc && vite build)
cd src-tauri && cargo check
```

## Architecture

Frontend renders; backend does all IO. They talk over Tauri IPC (`invoke`).
Outside Tauri (plain `vite`), `src/ipc.ts` routes `invoke` to `src/mock.ts`
(an in-memory macOS-like tree) so the whole UI runs and is testable in a
browser. `isTauri` gates native-only calls.

### Frontend (`src/`)

| File | Role |
| --- | --- |
| `main.ts` | App shell: tabs (files + system tabs), tab bar / integrated titlebar, keyboard wiring, settings + shortcuts tab hosting, per-pane `PaneHost`, restore/persist, orchestration of preview / favorites / sort-link / column-link. |
| `pane.ts` | `PaneView` — the core. One directory pane: list/grid/chips rendering (all **virtualized**), sorting, tree disclosure, selection, drag-out, columns (order/resize/visibility), size bars, recency, opposite-pane preview, favorites dropdown. Big file; most feature work lands here. |
| `state.ts` | Global `state` (tabs, settings, locations, keybindings, columnOrder, …), defaults, debounced `persist()` → `save_state`, `normalizeColumnOrder`. |
| `types.ts` | All shared types: `Entry`, `Listing`, `Details`, `Settings`, `PaneState`, `ColKey`/`COL_KEYS`, `SortKey`, etc. |
| `commands.ts` | Keyboard **command registry** + combo encode/label helpers (`comboFromEvent`, `comboLabel`, `mergeKeybindings`). Add a shortcut here. |
| `keyboard.ts` | Global keydown handler: encodes the combo, looks it up in the effective bindings, runs the command. Text-field guard + native-edit passthrough (⌘C/X/V/A/Z). |
| `keybindingsPage.ts` | The Shortcuts tab UI (record / remove / reset / conflict-steal). |
| `settingsPage.ts` | The Settings tab UI (`SettingsHooks` interface + controls). |
| `sysicons.ts` | Async caches for system icons, per-item `Details`, and QuickLook thumbnails (keyed by size). |
| `icons.ts` | Inline SVG icon set + per-filetype icons. |
| `format.ts` | `humanSize`, date formatting, `recency`, `clamp`. |
| `theme.ts`, `toast.ts`, `ipc.ts`, `mock.ts` | Theme apply/observe; transient toasts; IPC wrapper + `isTauri`; browser mock. |
| `styles.css` | All styling. CSS custom-property theme tokens; grid-based list columns via `--grid-cols`. |

### Backend (`src-tauri/src/`)

| File | Commands / role |
| --- | --- |
| `lib.rs` | `run()`: registers plugins (**drag**, **window-state**), the invoke handler, and `setup` (first-run 80% window sizing, macOS `setInspectable`, menu, actions init). |
| `fs_cmds.rs` | `list_dir` (the hot path — returns `Entry[]` with size/modified/created/permissions), `home_dir`, `perm_string` (Unix rwx string). |
| `details.rs` | `item_details` (created, owner, permissions, default app, dir count + first children) and `file_thumbnail` (QuickLook via `qlmanage`). Chips view + preview. |
| `icons.rs` | `file_icon` — system icon as PNG data URI (NSWorkspace). |
| `actions.rs` | `open_path` (default app), `quicklook`/`quicklook_close` (in-process `QLPreviewPanel`), `toggle_devtools`/`close_devtools` (WKWebView inspector). |
| `roots.rs` | `fs_roots` (filesystem roots abstraction), `dropbox_dir` (reads `~/.dropbox/info.json`). |
| `settings.rs` | `load_state`/`save_state` — one JSON file in `app_config_dir`, atomic write. |
| `menu.rs` | Native menu. |
| `quicklook.m` | Obj-C `QLPreviewPanel` data source/delegate (compiled by `build.rs` on macOS only). |

## Key concepts / where things live

- **Persistence:** `state.ts persist()` (debounced) → `save_state` → `~/Library/Application Support/com.trencseni.delight/settings.json`. Window bounds are separate: `.window-state.json` via `tauri-plugin-window-state` (writes on graceful `RunEvent::Exit`; first run with no file → `lib.rs` sizes to 80% + centers).
- **Keybindings:** every shortcut is a `Command` in `commands.ts`. To add one: add the id to `CommandId`, an entry to `COMMANDS` (label, group, default combo), and a handler in `main.ts`'s `commandHandlers`. `main.ts` builds a combo→id map; the Shortcuts tab edits `state.keybindings`.
- **Selection model** (`pane.ts`): `selection: Set<number>` (view indices) + `anchor`; `..` (UP_ENTRY) is never selectable. Plain-click on an already-multiselected row defers to mouseup so a drag can carry the whole set. Persisted-by-identity across sort via row `key`.
- **Drag-out:** `dragstart` on the row layer gathers selected absolute paths and calls `tauri-plugin-drag`'s `startDrag` (native `NSDraggingSession`). Read-only copy. `icon` must be a `data:image/png;base64,...` URI (generated on a canvas).
- **Columns:** order = `state.columnOrder` (linked) or `PaneState.colOrder` (per-pane, when `linkedColumns` off). `pane.ts columns()` filters by visibility + maps to descriptors; the row and header build from the same list; `--grid-cols` sets the CSS grid.
- **Views** are all virtualized in `pane.ts` (list rows, grid tiles, chips accordion where only the cursor item is a tall chip via `expandedIndex()`).

## Testing / verification

- **Browser preview + mock is the main harness.** Run `pnpm dev`, then use the
  Claude preview tools (`preview_start`, `preview_eval`, `preview_screenshot`,
  `preview_console_logs`) to drive and verify the UI. `src/mock.ts` fakes the FS
  (incl. a 10k-entry dir, symlinks, denied dir, dotfiles).
- **Do NOT hijack the user's machine to test the native app.** No
  `osascript`/System Events `set frontmost`, no synthetic keystrokes, no
  full-screen `screencapture` (privacy). Verify native-only behavior via logs /
  state / the mock, or ask the user to drive it. See the user's memory note.
- Typecheck (`tsc`) and `cargo check` before building. After a change, rebuild
  and relaunch (`pkill -x delight; open .../Delight.app`) so the user sees it.

## Gotchas

- `src/sysicons.ts` uses a **NUL byte (`\x00`)** as the cache-key separator
  (`` `${dir}\x00${name}` ``) — deliberate (a space could collide), so git flags
  that one file as binary. Don't "fix" it with a space.
- macOS TCC re-prompts for folder access on every rebuild **unless** the app has
  a stable code signature. It's signed with a self-signed cert
  ("Delight Self Signed" in a dedicated `delight-signing.keychain-db`); see
  `tauri.conf.json` `bundle.macOS.signingIdentity` + the `beforeBuildCommand`
  keychain unlock. (Details in the user's memory file.)
- Chips: `expandedIndex()` returns -1 when the cursor is on `..`, so `..` never
  becomes a chip. Chip height must fit the tile layout (`chipH()`).

## Cross-platform status (Mac ✅ / Win / Linux)

The build is already fenced (`#[cfg]`, `PathBuf`, no hardcoded separators;
`open_path` handles `open`/`cmd start`/`xdg-open`; `build.rs` only compiles
`quicklook.m` on macOS; icons/quicklook/devtools have non-macOS stubs). When you
start on Windows/Linux, these are the known gaps — most degrade gracefully:

| Area | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| Directory listing, nav, sort, columns, tabs, selection, favorites, size bars, themes, zoom, keybindings, window-state | ✅ | should work | should work | Pure-Rust `std::fs` + portable frontend. **Test first.** |
| `perm_string` (Permissions column) | ✅ rwx | ⚠️ returns `None` | ✅ rwx | Windows has no rwx; hide the column or show ACL summary. |
| `created` time | ✅ | ✅ | ⚠️ | `metadata().created()` is unsupported on some Linux FS → `None`. |
| System file icons (`icons.rs`) | ✅ NSWorkspace | ❌ stub | ❌ stub | Falls back to vector icons. Win: `SHGetFileInfo`; Linux: icon-theme lookup. |
| Preview thumbnails (`file_thumbnail` via `qlmanage`) | ✅ | ❌ | ❌ | Opposite-pane preview shows only the icon without them. Win: `IThumbnailProvider`/`IShellItemImageFactory`; Linux: thumbnailers / Gio. |
| Quick Look window (Space fallback, `quicklook.m` + `actions.rs`) | ✅ | ❌ | ❌ | macOS-only. On other OSes only the in-pane preview makes sense. |
| "Opens with <app>" in chips (`default_app`) | ✅ | ❌ | ❌ | Win: `AssocQueryString`; Linux: `.desktop` / `xdg-mime`. |
| `dropbox_dir` | ✅ `~/.dropbox/info.json` | ⚠️ | ✅ | Windows stores it at `%APPDATA%\Dropbox\info.json` — add that path. |
| Drag-out (`tauri-plugin-drag`) | ✅ | ✅ | ✅ | Plugin is cross-platform; verify the OS drag lands. |
| Filesystem roots (`roots.rs`) | ✅ `/` | ⚠️ stub `C:` | ✅ `/` | Windows: enumerate drives (`GetLogicalDrives`); UI doesn't surface roots yet. |
| Integrated titlebar (traffic lights over tabs, `titleBarStyle:"Overlay"`, `.native` class) | ✅ | ❌ | ❌ | Overlay is macOS-only. Gate the titlebar CSS/insets per-OS or use standard chrome elsewhere. |
| **Signing / `beforeBuildCommand`** | ✅ | 🔴 breaks | 🔴 breaks | `tauri.conf.json`'s `beforeBuildCommand` runs `security unlock-keychain … ; pnpm build` — that's macOS-only shell. **Make it conditional (or move signing to a mac-only config) before building on Win/Linux.** |
| Code signing / TCC | self-signed cert | Authenticode (optional) | n/a | Only macOS needs it for the folder-perms-persistence reason. |

**Approach for a new platform:** build it, expect the fenced non-macOS stubs to
return `None`/no-op (graceful), fix the 🔴 `beforeBuildCommand` first, then work
down the ⚠️/❌ rows. Keep the "own design, not native emulation" rule — don't add
platform look-alikes.

## Conventions

- Read-only forever in v0.1 — never add FS-mutating commands without an explicit
  decision. Match the surrounding code's style (vanilla TS, small modules, inline
  SVG). Commit only when asked; the user checkpoints directly on `main`.
