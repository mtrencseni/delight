# CLAUDE.md — working on Delight Commander

Context for resuming development. Read this, then [SPEC.md](SPEC.md) for the
original intent. User-facing overview is in [README.md](README.md).

## What this is

**Delight Commander** ("Delight") — a Total Commander–style dual-pane file
manager. **macOS + Windows + Linux**. It was read-only
through v0.1; **v0.2 adds file operations** (copy / move / rename / new folder /
move-to-Trash — see `ops.rs`), each guarded and confirmed by default. Everything
else is still read-only. The Windows port keeps the "own design, not native
emulation" rule: identical UI, ⌘ shortcuts become Ctrl (file ops use the Norton
F-keys), the native menu is dropped (see below). File **previews/thumbnails work**
via the Shell's `IShellItemImageFactory`; an **Alt+F1/F2 drive picker** replaces
the single-root model; and the few remaining OS-only extras (Quick Look's
standalone panel, list/grid system icons) degrade gracefully to the vector icons.

**Design principle — "delight":** snappy, keyboard-first, no jank, subtle
~120ms animations, its own single design on all platforms (NOT native
emulation). All icons are inline SVG; bundled Inter font; everything scales via
root `rem` so zoom Just Works. If a feature can't feel good, cut it.

## Stack & commands

- **Tauri 2** (Rust backend + WKWebView on macOS / WebView2 on Windows / WebKitGTK on Linux) +
  **vanilla TypeScript / Vite** + **pnpm**.
- All filesystem access is via Rust `#[tauri::command]`s; the webview never
  touches the disk. Commands are async and must not block the UI.

```sh
pnpm install
pnpm tauri dev            # native app + HMR
pnpm dev                  # browser-only against src/mock.ts (no native shell)
pnpm tauri build          # macOS → …/bundle/macos/Delight.app + …/bundle/dmg/*.dmg
                          # Windows → …/release/delight.exe (releases ship this, --no-bundle)
                          # Linux → …/bundle/deb/*.deb + …/bundle/appimage/*.AppImage
                          #   (needs Tauri's GTK/WebKitGTK dev packages: libwebkit2gtk-4.1-dev
                          #    librsvg2-dev libxdo-dev libayatana-appindicator3-dev libssl-dev)
scripts/linux-build.sh    # the same Linux build inside an ubuntu-22.04 container (docker),
                          # for a host without those dev packages → target/linux-docker/
./node_modules/.bin/tsc   # typecheck (also: pnpm build runs prebuild + tsc + vite build)
cd src-tauri && cargo check
```

## Cutting a release

Pushing a `v*` tag is the whole trigger: `.github/workflows/release.yml` builds
the Windows x64 portable exe and the Linux x64 .deb + AppImage on runners and
opens a **draft** release. macOS is not built in CI — attach it from a Mac. Do these in order:

1. **Update the docs to match what shipped.** Every release, before tagging:
   - `README.md` — the Features section and the shortcut table. This is the file
     that goes stale fastest, because features land without anyone re-reading
     it. Check the shortcut table against `COMMANDS` in `src/commands.ts`
     rather than trusting it: extract the defaults with
     `grep -oE '\{ id: "[a-zA-Z]+".*defaults: \[[^]]*\]' src/commands.ts`.
     Never name a version number in the README — it dates the file, and the
     download links already point at "latest".
   - `PRODUCT.md` — especially "What Delight is not", which is where a shipped
     feature contradicts an old promise (v0.2's SMB/SFTP did exactly that).
   - `ARCHITECTURE.md` — new subsystems and their seams.
   - This file — the cross-platform status table.
   A whole feature can land with none of these touched: the v0.3 web port
   shipped `server/`, a crate split, a security jail and two new commands
   without a single markdown file changing. Diff the docs against the log
   (`git diff --name-only vPREV..main -- '*.md'`) before trusting them.
2. **Bump the version in all SIX places**, or the workflow fails the build:
   `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `core/Cargo.toml`, `server/Cargo.toml`, and `Cargo.lock` (a `cargo check`
   refreshes it — and note the lock now lives at the repo ROOT, not in
   `src-tauri/`, since the Rust became a three-crate workspace). The tag must
   match `tauri.conf.json` exactly — three-part semver, `v0.2.0` not `v0.2`.
   Check with:
   `grep -rn '^version' Cargo.lock core/Cargo.toml server/Cargo.toml src-tauri/Cargo.toml | head`
3. `git tag -a vX.Y.Z && git push origin vX.Y.Z`, then watch
   `gh run list --repo mtrencseni/delight`.
4. **Build and attach macOS** once CI is green:
   ```sh
   pnpm tauri build
   # upload the .dmg TWICE — versioned for the archive, unversioned because
   # /releases/latest/download/<file> only resolves if the name is identical in
   # every release, which is what the README links depend on.
   cp …/Delight_X.Y.Z_aarch64.dmg Delight-X.Y.Z-macos_arm64.dmg
   cp …/Delight_X.Y.Z_aarch64.dmg Delight-macos_arm64.dmg
   shasum -a 256 <each> > <each>.sha256
   gh release upload vX.Y.Z *.dmg *.sha256 --repo mtrencseni/delight --clobber
   ```
   Then re-download and verify every checksum before publishing.
5. **Write the notes and publish.** `generate_release_notes` produces only a
   changelog link (everything lands straight on `main`, so there are no PR
   titles to harvest) — replace it from `git log vPREV..vNEW`. Keep the
   unsigned-build caveat: the macOS app is self-signed, so Gatekeeper blocks it
   elsewhere, and the Windows exe trips SmartScreen.
   `gh release edit vX.Y.Z --notes-file … --draft=false --latest`

Note: both repos are **private**, so `/releases/latest/download/…` 404s for
anyone not signed in with access. The README links only work for collaborators
until the repos go public.

## Platform partitioning — the rule

Every OS difference lives in **exactly one place**, so no platform's settings sit
in a shared file another has to override back. When you add a platform-specific
behavior, put it in the matching seam — never fork a shared file with an `if`:

| Seam | Holds |
| --- | --- |
| `src/platform.ts` | The single frontend OS branch: `isMac`, `MOD` (`Meta` on macOS, `Ctrl` elsewhere). Everything else imports these — no other file sniffs the platform. |
| `.mac` root class | Set in `main.ts` alongside `.native` only on macOS. CSS gates mac-only chrome (the traffic-light title-bar inset) to `:root.native.mac`; Windows keeps standard window chrome. |
| Rust `#[cfg(target_os = …)]` | Native capability splits: `menu.rs` (real menu on macOS, no-op stub elsewhere), plus the pre-existing icon/thumbnail/quicklook/default_app stubs. `roots.rs` has one `native_roots` per OS; `details.rs` one `thumbnail` per OS. |
| `tauri.<os>.conf.json` | Per-OS Tauri config merged over the base (**arrays replace wholesale** — the macOS window entry is restated in full to add `Overlay`/`hiddenTitle`). macOS: `app` target + signing. Windows: `nsis` target. Linux: `deb` + `appimage` targets. Base stays platform-neutral. |
| `scripts/prebuild.mjs` | The build-time shell that was macOS-only (keychain unlock). Runs only when `platform() === "darwin"`; the Tauri config just calls `pnpm build`. |
| `scripts/linux-build.{Dockerfile,sh}` | The Linux toolchain as a container, mirroring the CI job (same ubuntu-22.04 base, same apt list). Caches go under `target/linux-docker/`; node_modules get anonymous volumes so the host's never mix with the container's glibc. |

Shortcut **labels** follow `MOD` too: `comboLabel` renders `⌘⇧.` on macOS and
`Ctrl+Shift+.` on Windows; button tooltips use `state.hint(id)` so they read
correctly per platform. The native ⌘/Ctrl clipboard combos are whitelisted in
`keyboard.ts`'s `NATIVE_EDIT` (built from `MOD`, plus Windows `Ctrl+Y` redo).

## Architecture

Frontend renders; backend does all IO. They talk over Tauri IPC (`invoke`).
Outside Tauri (plain `vite`), `src/ipc.ts` routes `invoke` to `src/mock.ts`
(an in-memory macOS-like tree) so the whole UI runs and is testable in a
browser. `isTauri` gates native-only calls.

### Frontend (`src/`)

| File | Role |
| --- | --- |
| `main.ts` | App shell: tabs (files + system tabs), tab bar / integrated titlebar, keyboard wiring, settings + shortcuts tab hosting, per-pane `PaneHost`, restore/persist, orchestration of preview / favorites / sort-link / column-link. |
| `pane.ts` | `PaneView` — the core. One directory pane: list/grid/chips rendering (all **virtualized**), sorting, tree disclosure, selection (incl. icon-view marquee), drag-out, columns (order/resize/visibility), size bars, recency, preview icons, opposite-pane preview (image thumbnail **or** the CodeMirror code preview), favorites dropdown, on-disk auto-refresh watcher. Big file; most feature work lands here. |
| `codepreview.ts` | `CodePreview` — a **read-only** CodeMirror 6 view for previewing text files (line numbers, minimap, syntax colors, Sublime selection, find, copy — no editing). `langForTextFile(name)` picks the language (or null → try a thumbnail, then fall back to a plain-text code preview). Tab blurs the editor back to the file list; the file list's Tab (`switchPane`) hops focus INTO it. Reads only `settings.codePreviewBytes` bytes (10K default; Settings → "Code preview size"). Built from the shared editor internals below. |
| `editor-core.ts`, `langs.ts` | **Symlinks into `../Buffers/src/`** — see "Shared editor" below. `editor-core.ts` = syntax HighlightStyle + Sublime selection layer + selection-whitespace + overlay scrollbar + minimap (imports `editor-core.css`); `langs.ts` = language registry. Do not edit here; edit the Buffers originals. |
| `state.ts` | Global `state` (tabs, settings, locations, keybindings, `columnOrder` + `columnWidths`, …), defaults, debounced `persist()` → `save_state`, `normalizeColumnOrder`. |
| `types.ts` | All shared types: `Entry`, `Listing`, `Details`, `Settings`, `PaneState`, `ColKey`/`COL_KEYS`, `SortKey`, etc. |
| `commands.ts` | Keyboard **command registry** + combo encode/label helpers (`comboFromEvent`, `comboLabel`, `mergeKeybindings`). Add a shortcut here. |
| `keyboard.ts` | Global keydown handler: encodes the combo, looks it up in the effective bindings, runs the command. Text-field guard + native-edit passthrough (⌘C/X/V/A/Z). |
| `keybindingsPage.ts` | The Shortcuts tab UI (record / remove / reset / conflict-steal). |
| `settingsPage.ts` | The Settings tab UI (`SettingsHooks` interface + controls). |
| Connect to a server (`dialog.ts connectDialog` + `pane.ts openConnect`) | The globe button in the path bar (left of the view segment; also the unbound `connectNetwork` command) opens a builder for a network path: protocol segment (SMB / SFTP — `PROTOCOLS` is the only protocol-aware part), server / user / port / folder fields, a **live preview of the URL it will hand back**, and recent servers from `state.visited` (remote only, deduped by authority so it lists machines, not every share). It **only returns a path** — `openConnect` puts it in the bar and calls `commitPathInput()`, so connecting, SMB sign-in, ssh:// aliasing and error reporting all stay on the one navigation path, and a failure leaves the built path in the bar to edit. Port shows only for SFTP; a blank SFTP folder means the login directory. |
| Per-drive memory (`pane.ts rememberDrivePath` / `goToDrive`) | Each pane remembers where it last was on every drive (`PaneState.driveDirs`, keyed by upper-case letter, persisted). Switching drives via the Alt+F1/F2 picker — click, Enter, or the bare-letter jump, all three route through `goToDrive` — resumes there instead of dropping you at the root. Per pane AND per tab, so the two sides keep their own places. Only real drive-letter paths are recorded: archives, smb:// and sftp:// have no drive to key on. A remembered folder that's since been renamed, deleted or unplugged falls back to the root and is dropped from the map, so a stale entry can't strand you. Windows-only in practice; `driveLetter()` returns null elsewhere, making it a no-op rather than a platform branch. |
| Path bar (`pane.ts`) | **⌘L / Ctrl+L** (`focusPath`) focuses the active pane's bar and selects the path — the browser gesture. (List view moved ⌘L → ⌘⇧L for it; `mergeKeybindings` migrates a saved ⌘L, or two commands would answer one combo.) Focus adds `.editing` to the bar, which hides the drive-root disk readout and the `.pathgap` spacer and drops the explicit `size` — at a root those squeeze the field to ~4 characters exactly when you need room to type. Typing ≥2 chars opens **recent-path autocomplete**: prefix matches (case-insensitive) from `state.visited` — the same LRU that drives the recent-folder highlight, so remote paths are already in it — newest first, max 8. ↑/↓ cycle through the suggestions *and* back to what you typed, Tab completes without navigating (so a long path can be extended), Esc closes the list before it closes the bar, Enter/click commits. Suggestion clicks use **mousedown**, since click lands after blur has already reset the field. Enter and click share `commitPathInput()` so both honor smb sign-in, ssh:// aliasing and archive markers. |
| PDF preview (`pane.ts showPdfPreview`) | PDFs embed the real document in an iframe (crisp + scrollable) rather than using the OS thumbnail, which Windows caps at 256px. **Two sources**, because the asset protocol resolves a real local filesystem path: local and **SMB** files go through `native_path` (smb:// → UNC) + `convertFileSrc`, which streams and has no size limit; **archives and SFTP** have no such path, so the bytes come back base64 via `read_file_bytes` and become a **blob: URL** (hence `frame-src blob:` in the CSP) — no temp file, keeping the no-materialization rule. Capped at 64 MB; over that the pane says so rather than rendering a truncated (i.e. corrupt) PDF. Blob URLs are revoked when the preview changes or closes. |
| `sftp.ts` | Frontend half of SFTP: `isSftpPath`/`isRemotePath` and `canonicalSftp` (rewrites the `ssh://` alias and drops any typed password — OpenSSH takes none on the command line). pane.ts uses these for the path-bar commit, skipping the auto-refresh watcher, and exempting URL paths from the path-separator setting. Drag-out and open-with are already gated by the listing's `readOnly` flag, which SFTP sets. |
| `smb.ts` | Frontend half of SMB: `isSmbPath`, the auth sentinel, and `smbParse` (strips an inline password so it's used once for `smb_login` and never persisted). pane.ts uses these for the path-bar commit, the sign-in retry loop in `navigate()`, skipping the auto-refresh watcher on smb paths (no polling over the network), and exempting smb from the path-separator display setting. |
| `sysicons.ts` | Async caches for system icons, per-item `Details`, and QuickLook thumbnails (keyed by size). |
| `icons.ts` | Inline SVG icon set + per-filetype icons. |
| `format.ts` | `humanSize`, date formatting, `recency`, `clamp`. |
| `theme.ts`, `toast.ts`, `ipc.ts`, `mock.ts` | Theme apply/observe; transient toasts; IPC wrapper + `isTauri`; browser mock. |
| `styles.css` | All styling. CSS custom-property theme tokens; grid-based list columns via `--grid-cols`. |

### Backend — three crates (`core/`, `src-tauri/`, `server/`)

The Rust is a **workspace**, not one crate, and the file table below lives in
`core/src/` unless noted. `core/` (`delight-core`) owns every module that does
filesystem work; it has no Tauri dependency, and takes what it needs from a host
through two traits — `Env` (well-known directories; the OS answers these better
than `$HOME` does) and `Emitter` (progress). `src-tauri/` is a window plus thin
`#[tauri::command]` wrappers. `server/` is an axum host over the same core.

**Why split rather than feature-gate:** Tauri pulls in GTK/WebKitGTK on Linux,
and a headless file server must not build a webview. Anything you add that both
hosts need goes in `core/`; anything that needs a window goes in `src-tauri/`.

`server/src/jail.rs` is the one place a browser-supplied path becomes a path the
process will touch, and the ORDER of its checks is the security property — see
ARCHITECTURE.md. Don't refactor it for elegance; symlinks must resolve before
the roots test, `..` must never be resolved lexically, and the archive marker is
split off before either.

Run it with `pnpm build` then
`cd server && DELIGHT_TOKEN=… cargo run --release` (`DELIGHT_ROOTS`,
`DELIGHT_READ_ONLY=1`, listens on 127.0.0.1:8787).

| File | Commands / role |
| --- | --- |
| `lib.rs` | `run()`: registers plugins (**drag**, **window-state**), the invoke handler, and `setup` (first-run 80% window sizing, macOS `setInspectable`, menu, actions init). |
| `fs_cmds.rs` | `list_dir` (the hot path — returns `Entry[]` with size/modified/created/permissions), `home_dir`, `perm_string` (Unix rwx string), `read_text_file` (read-only, capped at `CODE_PREVIEW_MAX` bytes, reports `truncated`/`binary`; powers the code preview). |
| `details.rs` | `item_details` (created, owner, permissions, default app, dir count + first children) and `file_thumbnail` (QuickLook via `qlmanage`). Chips view + preview. |
| `icons.rs` | `file_icon` — system icon as PNG data URI (NSWorkspace). |
| `actions.rs` | `open_path` (default app), `quicklook`/`quicklook_close` (in-process `QLPreviewPanel`), `toggle_devtools`/`close_devtools` (WKWebView inspector). |
| `ops.rs` | **The only mutating commands:** `copy_entries`/`move_entries` (recursive; overwrite flag; refuse into-itself; same-folder copy auto-dedups "… copy"), `rename_entry`, `create_folder`, `trash_entries` (via the `trash` crate — never a hard unlink). Driven from `main.ts`'s `doTransfer`/`doRename`/`doNewFolder`/`doTrash` with a `dialog.ts` confirm/prompt (Norton/Total-Commander F-keys F5/F6/⇧F6/F7/F8 on Windows/Linux, number keys 5/6/⇧6/7/8 on macOS — the per-OS split lives in `commands.ts`; confirm gated by `settings.confirmOps`). |
| `roots.rs` | `fs_roots` (filesystem roots for the drive picker: `/` on macOS, drive letters on Windows, `/` + `/media`, `/run/media`, `/mnt` mounts from `/proc/mounts` on Linux), `dropbox_dir` (reads `~/.dropbox/info.json`). |
| `settings.rs` | `load_state`/`save_state` — one JSON file in `app_config_dir`, atomic write. |
| `sftp.rs` | SFTP over the **system ssh binary**: `ssh -s user@host sftp` starts the remote sftp subsystem and we speak the protocol over the child's stdin/stdout (`openssh-sftp-client`). SFTP always runs inside an SSH channel, so this is the same protocol any client speaks — OpenSSH just owns the SSH layer, which buys `~/.ssh/config`, agent keys, `known_hosts` and ProxyJump for free and keeps host-key verification out of our hands. UI form: `sftp://[user@]host[:port]/abs/path`; `ssh://` is an alias, canonicalized to `sftp://`. One pooled ssh process per authority (`kill_on_drop`, so nothing is orphaned); every entry point goes through `redial!`, which drops a dead session and retries once (a pooled session dies on server restart/sleep — the crate reports it as "background task failed", so that string counts as a disconnect). v1 is **read-only + copy-out**: `plan` walks the tree using the attributes READDIR already returned (statting each entry separately made a walk of /etc take 77 s) and records unreadable items and symlinks as **skips instead of aborting** — one locked-down subdirectory must not cost the user the other 500 files. `download` streams in 64 KB chunks and checks cancellation between them. Auth runs with `BatchMode=yes`: a GUI has no TTY, so a prompt would hang; failures come back as ssh's own stderr with a hint appended (an `SSH_ASKPASS` helper is the planned follow-up). Windows spawns get `CREATE_NO_WINDOW` or a console flashes. |
| `smb.rs` | SMB via the OS, no protocol client. The UI speaks `smb://[user@]host/share/…` everywhere (portable — a favorite saved on Windows works on the Mac); `localize()` translates at every command entry (ops/details/actions call it too), `delocalize()` rewrites listing paths back so the UI never sees a native path. `localize_checked()` is the one variant allowed side effects and failure — navigation calls it, everything downstream calls the infallible `localize`. Listings answer the `__smb_auth_required` sentinel → frontend sign-in dialog → retry. Inline `smb://user:pass@host` passwords are used once and never stored/shown. **Windows:** UNC (`\\host\share`), shares via `NetShareEnum`, `smb_login` = `WNetAddConnection2W` to `\\host\IPC$` (fails on wrong creds — nothing broken cached); the separator flip stops at the archive `!` boundary, so archives inside shares compose. **macOS:** a share is a *volume*, so `localize_checked` mounts it via `NetFSMountURLSync` (NetFS.framework — the call behind Finder's Connect to Server, so the Keychain answers for servers already used, and a password is passed as an argument, never in argv). Mount on first access, never unmounted, and the mount point is always read back — from NetFS, else `getmntinfo` — because a name collision silently turns `/Volumes/x` into `/Volumes/x-1`. Shares come from `smbutil view -N`, which does **not** mount, so opening a server is side-effect-free; `$`-shares are hidden on both platforms. See "SMB on macOS" below for what only a live server can tell you. |
| `menu.rs` | Native menu. |
| `quicklook.m` | Obj-C `QLPreviewPanel` data source/delegate (compiled by `build.rs` on macOS only). |

## Shared editor (linked with Buffers)

The read-only **code preview** (Space on a text file → CodeMirror in the opposite
pane) reuses **Buffers'** editor verbatim so the two apps stay identical and fixes
propagate. It is a real link, not a copy:

- `src/editor-core.ts` and `src/langs.ts` are tiny **re-export shims** —
  `export * from "../../Buffers/src/<file>"` — into the sibling Buffers repo
  (`editor-core.css` rides along transitively via editor-core.ts's own import).
  Those Buffers files are **dependency-closed** (import only CodeMirror + their
  own CSS/types) precisely so they can be linked this way. Edit the **Buffers**
  originals; never these shims.
  - **Why re-exports and not symlinks:** they used to be git symlinks, but
    Windows can't check a symlink out without admin / Developer Mode (it lands as
    a plain stub file and the build breaks). A re-export resolves to the exact
    same physical file on every OS, needs no privileges, and stays byte-identical
    on macOS — one mechanism, no per-platform checkout surprises.
- Requires both repos checked out **side-by-side** under `Repositories/` (folder
  names `Buffers` + `Delight`; the shims hardcode `../../Buffers/…`). A clone of
  only Delight can't resolve the shims (the preview won't build). `tsc` and Vite
  follow the re-exports fine.
- `codepreview.ts` builds the read-only `EditorView` from those shared pieces;
  `pane.ts showCodePreview()` wires it into the opposite-pane preview and
  `read_text_file` feeds it. The editor host gets class `edhost cmprev`;
  `editor-core.css` scopes its **Mariana/One-Light** tokens to `.edhost`, so the
  preview keeps Buffers' editor palette regardless of Delight's own theme.
- **CodeMirror must be a single instance** (facets + the parser's syntax-tree
  node types are identity-based). Because the re-exports resolve into Buffers,
  their bare `@codemirror/*` / `@lezer/*` imports would otherwise resolve from
  *Buffers'* `node_modules` → a second `@lezer/common` → the highlighter silently
  no-ops (`TypeError: tags is not iterable`). `vite.config.ts` fixes this with
  `resolve.alias` pinning every CM/Lezer package to an **absolute path in
  Delight's own `node_modules`** (dedupe/optimizeDeps.include were NOT enough).
  Every pinned package is therefore a **direct** dependency in `package.json`
  (pnpm only top-level-links direct deps, which the alias targets). After
  touching this, `rm -rf node_modules/.vite` before restarting dev.

## Key concepts / where things live

- **Persistence:** `state.ts persist()` (debounced) → `save_state` → `~/Library/Application Support/com.trencseni.delight/settings.json`. Window bounds are separate: `.window-state.json` via `tauri-plugin-window-state` (writes on graceful `RunEvent::Exit`; first run with no file → `lib.rs` sizes to 80% + centers).
- **Keybindings:** every shortcut is a `Command` in `commands.ts`. To add one: add the id to `CommandId`, an entry to `COMMANDS` (label, group, default combo), and a handler in `main.ts`'s `commandHandlers`. `main.ts` builds a combo→id map; the Shortcuts tab edits `state.keybindings`.
- **Selection model** (`pane.ts`): `selection: Set<number>` (view indices) + `anchor`; `..` (UP_ENTRY) is never selectable. Plain-click on an already-multiselected row defers to mouseup so a drag can carry the whole set. Persisted-by-identity across sort via row `key`.
- **Drag-out:** `dragstart` on the row layer gathers selected absolute paths and calls `tauri-plugin-drag`'s `startDrag` (native `NSDraggingSession`). Read-only copy. `icon` must be a `data:image/png;base64,...` URI (generated on a canvas).
- **Columns:** ONE global spec — `state.columnOrder` + `state.columnWidths`, shared by every pane and tab. Reorder or resize anywhere → write global + `host.columnsChanged()` refreshes all panes. `pane.ts buildCells()` builds the ordered cells once; both list rows AND the compact chips rows use it, so they share the exact same columns (incl. Perms) and align under one header. `--grid-cols` + `--w-*` set the CSS grid. (The old per-pane `colOrder`/`colWidths` + `linkedColumns` toggle were removed; `PaneState` still carries the now-unused fields.)
- **Views** are all virtualized in `pane.ts` (list rows, grid tiles, chips accordion where only the cursor item is a tall chip via `expandedIndex()`). Default view is **chips + Bigger chips** (`state.settings.bigChips`, on by default; `chipH()` ~2×, `.big-chips` CSS lays out the big preview + 2-row detail tiles).
- **Icon-view marquee** (`pane.ts onMarqueeMouseDown`/`applyMarquee`): drag on empty grid space rubber-bands a selection (cells intersecting the rect, in content coords). A `requestAnimationFrame` loop auto-scrolls when the pointer nears/leaves the top/bottom edge and keeps extending the selection — so it can't be verified in a backgrounded preview tab (rAF is paused there; drive `scrollTop` manually to test).
- **Preview icons** (`applyPreviewIcon`, `previewIcons` setting): render a file's QuickLook content thumbnail as its list/grid icon (Finder-style, with a hairline outline in list), falling back to the system/vector icon when there's no preview. Uses the same `sysicons.ts` thumbnail cache (keyed by px size) as the Space preview, so the chip preview and Space preview share loads when `previewSize` matches.
- **Opposite-pane preview** persists across folder changes: the pane host's `changed()` **refreshes** the preview to the new cursor item instead of closing it (Finder-like). It closes only on tab switch or when you click the previewing pane.

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
- **Hidden-until-painted launch is a trio — keep all three in sync** or you get
  either the white flash back or an invisible window: (1) `visible: false` in the
  base **and** `tauri.macos.conf.json` window (arrays merge wholesale, so the mac
  override must restate it); (2) the window-state plugin must exclude
  `StateFlags::VISIBLE` (else it restores visibility pre-paint); (3) the frontend
  must actually call `show_main_window` (double-rAF at the end of `init()`). The
  3s failsafe thread in `lib.rs setup` is the backstop if (3) never runs.
- Rebuild fails with "Access is denied" removing `delight.exe` when a copy is
  running — close the app first (`taskkill /F /IM delight.exe`).

## SMB on macOS — what only a live server tells you

Everything here was measured against a real Windows server, not inferred; the
pure-string unit tests in `smb.rs` passed the whole time these were broken.

- **Never guess the mount point.** Mounting the same share twice gives
  `/Volumes/torrents` *and* `/Volumes/torrents-1` — two volumes for one share.
  `delocalize` therefore tests the native path against **every** mount of that
  share, and the prefix test requires a `/` boundary, or `/Volumes/torrents`
  would swallow `/Volumes/torrents-1`.
- **Mounting is serialized** (`MOUNTING` in `smb.rs`). Two panes opening the
  same share at once don't collide loudly — the loser *succeeds*, at
  `…-1`. Found by running the live tests in parallel, which is the same race.
- **`smbutil` never prompts** on current macOS: it answers from the Keychain or
  an existing session, or exits 77 (`EX_NOPERM`). So there is no password
  prompt to feed via a pty; credentials reach the server only through
  `NetFSMountURLSync`'s arguments.
- **Sessions are shared per server.** Once any share is mounted, `smbutil view`
  enumerates that server without credentials. Cold, a server that wants
  credentials returns the auth sentinel → sign-in dialog → the retry mounts.
- **`smbutil` resolves DNS/mDNS only, not NetBIOS.** A bare `powerplant` (what
  a Windows favorite carries) fails there, so `host_spellings` retries as
  `powerplant.local`. NetFS resolves the bare name itself, so mounting doesn't
  need this — and `same_host` treats the two spellings as one machine, with an
  IPv4 guard so `192` can't match every `192.x.x.x`.
- **Two refusals, opposite handling.** Rejected credentials → the sentinel, so
  the dialog reopens. A share this identity can't open, or that doesn't exist →
  NTSTATUS `0xC000019C`, which must NOT reopen the dialog (a mistyped share
  name would loop forever). The server doesn't distinguish the two, so the
  message names both possibilities.
- macOS mounts and **never unmounts** — the same way Delight never closes a
  Finder window it didn't open.

Live tests (all `#[ignore]`d, all read-only):

```sh
cd src-tauri
DELIGHT_SMB_TEST=smb://server/share cargo test smb -- --ignored --nocapture
DELIGHT_SMB_TEST=smb://server       cargo test smb -- --ignored --nocapture  # also share enumeration
DELIGHT_SMB_PROBE_HOST=server       cargo test refusals -- --ignored --nocapture
DELIGHT_SFTP_TEST=sftp://user@host  cargo test sftp -- --ignored --nocapture
```

## Cross-platform status (Mac ✅ / Win ✅ / Linux ✅)

All three build and run. The backend is fenced (`#[cfg]`, `PathBuf`,
no hardcoded separators; `open_path` handles `open`/`cmd start`/`xdg-open`;
`build.rs` only compiles `quicklook.m` on macOS; icons/quicklook/menu have
non-macOS stubs). Off macOS the OS-only features degrade gracefully rather than
erroring. Remaining items are polish, not blockers:

| Area | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| Directory listing, nav, sort, columns (global spec), tabs, selection (incl. icon marquee + auto-scroll), favorites, size bars, themes, zoom, window-state | ✅ | ✅ | ✅ | Pure-Rust `std::fs` + portable frontend. |
| Keyboard shortcuts | ✅ ⌘ | ✅ Ctrl | ✅ Ctrl | `MOD` in `src/platform.ts` is `Meta` on macOS, `Ctrl` elsewhere; `commands.ts` defaults + labels + `keyboard.ts` `NATIVE_EDIT` are built from it (`Ctrl+Y` redo added for Windows). Rebindable in the Shortcuts tab. |
| Native menu (`menu.rs`) | ✅ global menu bar | ✅ dropped | dropped | A Win/Linux menu bar paints in un-themable system colors *inside* the window and clashes with the tab-bar titlebar, so `install` is a macOS-only real menu / no-op elsewhere. The webview keeps every shortcut. |
| Integrated titlebar | ✅ traffic-light inset (`Overlay`, `:root.native.mac`) | ✅ standard chrome | standard chrome | `Overlay`/`hiddenTitle` live in `tauri.macos.conf.json`; off macOS the base config's standard window is used and the `.mac`-gated CSS inset doesn't apply. |
| Build / signing | ✅ `app` + self-signed | ✅ `nsis` installer + `delight.exe` | ✅ `deb` + `appimage`, unsigned | Per-OS `tauri.<os>.conf.json` targets; keychain unlock moved to `scripts/prebuild.mjs` (darwin-only). NSIS is unsigned → SmartScreen warns; bootstraps WebView2 on older Windows 10. CI builds Linux on ubuntu-22.04 so the AppImage's glibc floor stays low. |
| `perm_string` (Permissions column) | ✅ rwx | ⚠️ returns `None` | ✅ rwx | Windows has no rwx; the column shows blank. Could show an ACL summary later. |
| `created` time | ✅ | ✅ | ⚠️ | `metadata().created()` is unsupported on some Linux FS → `None`. |
| Hidden-until-painted launch | ✅ | ✅ | ✅ | `visible: false` in the base + macOS window config; `lib.rs` `show_main_window` (invoked after a double-rAF at the end of main.ts init), window-state plugin excludes `VISIBLE`, 3s failsafe thread. Kills the white flash on both. |
| Path display | ✅ | ✅ `C:\…` | ✅ | `dunce::canonicalize` (fs_cmds + ops) strips Windows' `\\?\` verbatim prefix so the path bar shows `C:\Users\…`, not `\\?\C:\Users\…`. No-op off Windows. |
| Hidden files (`fs_cmds::is_hidden`) | ✅ dotfiles | ✅ dotfiles + `HIDDEN`/`SYSTEM` attr | ✅ dotfiles | "Show hidden" also folds Windows attribute-hidden entries (`$Recycle.Bin`, `System Volume Information`, `pagefile.sys`, `desktop.ini`, …), read from `MetadataExt::file_attributes()`. |
| Preview thumbnails (`file_thumbnail`) | ✅ `qlmanage` | ✅ `IShellItemImageFactory` | ⚠️ freedesktop thumbnail cache (read-only) | Powers the opposite-pane preview, chip preview, AND the **Preview icons** setting. Windows: COM `SHCreateItemFromParsingName` → `GetImage` → HBITMAP → PNG (`details.rs hbitmap_to_png`), on a spawn_blocking thread with per-call STA `CoInitializeEx`. Linux: reads `~/.cache/thumbnails/<size>/<md5 of file URI>.png` — whatever the desktop's file manager already rendered; nothing is rendered or written, so files no other app has shown have no thumbnail. Running the thumbnailers ourselves (or Gio) is the upgrade path. |
| System file icons (`icons.rs`) | ✅ NSWorkspace | ⚠️ stub → vector | ⚠️ stub → vector | List/grid icons still fall back to the inline vector set (the *thumbnail* path above is separate). Win: `SHGetFileInfo`; Linux: icon-theme lookup. |
| Quick Look window (Space fallback, `quicklook.m` + `actions.rs`) | ✅ | ⚠️ in-pane only | ⚠️ in-pane only | macOS-only panel; the in-pane code/image preview still works everywhere. |
| "Opens with <app>" in chips (`default_app`) | ✅ | ⚠️ hidden | ⚠️ hidden | Win: `AssocQueryString`; Linux: `.desktop` / `xdg-mime`. |
| `dropbox_dir` | ✅ `~/.dropbox/info.json` | ⚠️ | ✅ | Windows stores it at `%APPDATA%\Dropbox\info.json` — add that path. |
| Drag-out (`tauri-plugin-drag`) | ✅ | ✅ | ✅ | Plugin is cross-platform; verify the OS drag lands. |
| Filesystem roots + drive picker (`roots.rs`) | ✅ `/` (single) | ✅ `GetLogicalDrives` | ✅ `/` + mounted volumes | Windows enumerates mounted drive letters; Linux lists `/` plus mounts under `/media`, `/run/media` and `/mnt` from `/proc/mounts`. The **Alt+F1 / Alt+F2** picker (`pane.ts openDrives`, commands registered only off macOS) navigates the left/right pane to a root; the active entry is the longest-prefix match, since `/` prefixes everything. Per-drive memory is Windows-only (`driveLetter()` is null elsewhere). |
| SMB (`smb.rs` + `src/smb.ts`) | ✅ NetFS mount + `getmntinfo` mount-point resolution, `smbutil view` share listing | ✅ UNC translation, `NetShareEnum` share listing, `WNetAddConnection2W` sign-in | ⚠️ `NOT_SUPPORTED` stub (gio mount is the natural route) | `smb://…` is the canonical form on every OS; only the translation layer is per-platform. |

**Devtools** (`actions.rs`): macOS drives WKWebView's private `_inspector`;
Linux uses Tauri's `open_devtools`/`close_devtools`/`is_devtools_open` (the
`devtools` feature is on, so it works in release). Windows is still a **no-op
stub** — wire it the same way as Linux.

Keep the "own design, not native emulation" rule — don't add platform look-alikes.

## Conventions

- All FS-mutating commands live in `ops.rs` and nowhere else; keep them guarded
  (validate names, refuse into-itself, never hard-delete — Trash only) and behind
  the confirm flow. Don't scatter write operations into the other command files.
  Match the surrounding code's style (vanilla TS, small modules, inline SVG).
  Commit only when asked; the user checkpoints directly on `main`.
