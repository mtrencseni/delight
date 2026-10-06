# Delight Commander — architecture

This document explains how Delight is built and why it's built that way. It's
meant to be read once, top to bottom, to form a mental model; after that you
navigate with [CLAUDE.md](CLAUDE.md), which carries the per-file tables,
per-platform status, and the accumulated gotchas. The product itself is
described in [PRODUCT.md](PRODUCT.md).

## The shape of the system

Delight is a Tauri 2 application: a Rust process owns the window and all IO,
and a webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) renders the entire
interface from a vanilla TypeScript + Vite frontend. The two sides talk over
Tauri's IPC — the frontend calls `invoke("list_dir", …)` and gets JSON back;
the backend pushes events (progress, menu actions) the other way.

The Rust is **three crates in one workspace**, and the split is load-bearing
rather than tidiness. `core/` (`delight-core`) holds every module that does
filesystem work, with the Tauri coupling replaced by two things a host has to
supply: an `Env` (the well-known directories, which the OS answers better than
`$HOME` does) and an `Emitter` for progress. `src-tauri/` is a window plus thin
command wrappers over that core. `server/` is an axum HTTP host over the same
core — the web port. The reason they're separate crates and not features of one
is that **Tauri drags in GTK/WebKitGTK on Linux**, and a headless box serving
files has no business building a webview.

The frontend is one build with two hosts. `src/target.ts` decides which it's
talking to and `src/ipc.ts` routes `invoke` accordingly: Tauri IPC in the app,
`fetch` to `/api/…` in the browser, and the in-memory mock under plain
`pnpm dev`. Feature code calls `invoke` and doesn't know the difference.

The boundary is strict and worth internalizing: **the webview never touches
the disk.** Every read goes through a `#[tauri::command]`; every write goes
through exactly one Rust module (`ops.rs`). This gives one place to audit for
safety, keeps the frontend testable without a filesystem, and means a frontend
bug can't corrupt user data — the worst it can do is ask the backend to do
something, and the backend validates.

There is one more seam that shapes everything: outside Tauri (plain
`pnpm dev`), `src/ipc.ts` routes every `invoke` to `src/mock.ts`, an in-memory
fake filesystem. The full UI — navigation, selection, archives, even file
operations — runs in an ordinary browser against the mock. This is the primary
development and verification harness; the native app is for what genuinely
needs the OS.

## Why these choices

**Vanilla TypeScript, no framework.** The hot paths are virtualized listings —
thousands of rows created, positioned, and recycled by hand. A framework's
render cycle adds overhead and indirection exactly where we need direct DOM
control, and the rest of the app (dialogs, settings forms, tab strip) is
simple enough that a framework would mostly be dependency weight. The cost is
some hand-rolled plumbing (each page wires its own DOM); it has stayed
manageable because modules are small and patterns repeat.

**Rust for all IO.** Directory listing, thumbnailing, archive decoding, and
file operations are CPU- or IO-bound work that must not stall the interface.
Commands are async; anything heavy runs on blocking threads. Archive decoding
is pure Rust by policy (no C dependencies to build per-platform).

**One design, all platforms.** The frontend renders the same pixels on macOS
and Windows: bundled Inter font, inline SVG icons, `rem`-based sizing so zoom
scales everything. Platform differences are confined to five specific seams
(below) rather than scattered through feature code.

## Frontend

The frontend is a single page with three layers:

- **`main.ts` — the shell.** Owns tabs (each holding a full dual-pane state),
  the tab bar / integrated titlebar, the settings and shortcuts tabs, dialogs,
  and orchestration that spans panes: file-operation flows (confirm → invoke →
  progress → refresh), pack/unpack, the preview lifecycle, favorites, sort and
  column synchronization.
- **`pane.ts` — the pane.** One class, `PaneView`, renders a directory as a
  list, chip list, or icon grid — all virtualized — and owns everything local
  to a pane: cursor and selection, sorting, inline tree expansion, the find
  bar, marquee selection, drag-out, the path bar, and the on-disk change
  watcher. This is the largest file in the app and most feature work lands
  here.
- **`state.ts` — the state.** A single mutable `state` object: settings, tab
  and pane snapshots, favorites, keybindings, the global column spec. A
  debounced `persist()` writes it as one JSON file via the backend. There is
  no store framework, no pub/sub — views re-render when the code that changed
  the state tells them to. At this app's size that's a feature: you can trace
  every update by grep.

**The keyboard system** is a registry, not scattered listeners. Every shortcut
is a `Command` in `commands.ts` — id, label, group, default combos. A single
keydown handler (`keyboard.ts`) encodes the event into a canonical combo
string ("Ctrl+Shift+KeyP"), looks it up in the user's effective bindings, and
runs the handler registered in `main.ts`. Because everything flows through
this one table, shortcuts are rebindable in the Shortcuts tab, the ⌘K keyboard
map renders itself from the same data, and tooltips derive their hints instead
of hardcoding key names. Combo strings are canonical across platforms; only
the *defaults* differ (`MOD` is Meta on macOS, Ctrl elsewhere).

**Theming and zoom** are CSS custom properties on `:root`. Light and dark are
token sets; zoom changes the root font size and everything follows because
the entire layout is in `rem`. List columns are a CSS grid whose template
comes from the global column spec (`--grid-cols`), which is why every pane can
share one header layout.

## Backend

The Rust side is organized by capability, with a hard read/write split.

**Read commands** are grouped by concern: `fs_cmds.rs` (directory listing —
the hot path — plus capped text-file reads for the code preview), `details.rs`
(per-item detail cards and thumbnails), `icons.rs` (system icons), `roots.rs`
(filesystem roots and drive letters), `actions.rs` (open-with, Quick Look,
devtools). Each returns plain serializable structs; none mutates anything.

**`ops.rs` is the only writer.** Copy, move, rename, new folder, trash,
extract-from-archive, and pack all live here, and they share one contract:
validate names, refuse to copy a folder into itself, never hard-delete
(the `trash` crate or nothing), and report what happened (`done`, `skipped`,
`cancelled`) rather than throwing away the outcome.

Long operations follow a progress protocol. The frontend generates an
operation id and passes it with the invoke; the backend registers a
cancellation flag (an `AtomicBool` in a global registry) under that id and
emits throttled `op-progress` events (~20 per second, bytes or items) tagged
with it. The frontend's progress dialog listens for its id and offers Cancel —
which just flips the flag via a `cancel_op` command; the operation polls it at
file boundaries and reports `cancelled` in its result. A guard struct removes
the registry entry on drop, so no path — success, error, or cancellation —
leaks a flag.

### The server (web port)

`server/` serves the built frontend and exposes the same commands over HTTP, so
the panes show the *server's* filesystem. Two things differ from the desktop,
and both follow from the boundary moving.

**`jail.rs` is the single place a path from the browser becomes a path this
process will touch**, and its ordering is the whole point. Symlinks are
resolved **before** the roots check, because a link pointing out of a root
would otherwise be a door through it. `..` is never resolved lexically — a path
containing it must canonicalize in full, since string surgery applied before
symlink resolution is precisely how these checks are normally defeated. And the
archive marker (`!`) is split off first, with only the real half checked. Roots
default to the home of the user running the server, never `/`; `DELIGHT_READ_ONLY`
refuses every mutating command.

Auth is the arrangement Buffers uses: a shared token, traded once at `/login`
for a signed HttpOnly cookie whose key derives from that token — so rotating the
token logs every browser out, with no session store to expire.

Upload and download are the one axis the desktop app doesn't have (there, the
files are already on this machine). Downloads stream: `zip` 2.x seeks back to
patch each local header, so a streaming writer was never possible — the archive
is built into a temp file, unlinked, and streamed from the still-open handle.
Preview needed almost nothing, since the editor was already Buffers' and PDFs
already had a viewer; both point at `/api/file`, which honours `Range`, so a
400-page document opens without being fetched whole.

### The archive subsystem

`archive.rs` gives the rest of the backend a way to treat archives as
directories, without temp files. The design decisions:

- **Paths cross the boundary inline.** An entry inside an archive is addressed
  as `C:\backups\photos.zip!2024/june/img.jpg` — the `!` marks where the real
  filesystem ends. Parsing is conservative: the marker only splits if the text
  to its left names an archive by extension, so a folder legitimately named
  `my!stuff` still works. The marker is an implementation detail; the frontend
  re-renders it as a plain separator (`displayPath`), so users never see it.
- **An index, not an extraction.** Opening an archive builds an in-memory
  table of its members (path, size, mtime, mode, link target, encrypted flag)
  in one pass. Directory listings, size rollups, and detail cards are all
  answered from this index. Indexes live in a small LRU cache keyed by the
  archive's path, mtime, and size, so an archive modified on disk is re-read
  and a stale index can't be served.
- **Traversal is neutralized at index time.** Member paths are normalized as
  they're read — `..` segments resolved, absolute paths stripped — so a
  malicious archive (zip-slip) can't address anything outside its extraction
  target. Extraction also plans directories before files, so empty directories
  survive, and restores each file's recorded mtime and read-only bit.
- **Formats are pure Rust.** Zip (with its derived formats: jar, docx, apk…),
  7z, tar, and the gz/bz2/xz/zst compressors, as containers or bare. xz's
  decoder only offers a push (`Write`) interface, so a worker thread and a
  bounded channel adapt it into the streaming `Read` the tar layer expects.
  rar was considered and rejected for licensing reasons.
- **Passwords are verified before they're cached.** Encrypted zip entries
  surface as a typed "needs password" error; the frontend prompts and submits
  the password to the backend, which test-decrypts before storing it —
  a wrong password is rejected at the door instead of poisoning the session.
  Passwords live only in backend memory, keyed by archive path, never on disk.

Because there are no temp files, features that would require materializing an
entry — open in default app, thumbnails inside archives — are declined rather
than faked. Copy-out (a real, user-visible extraction to a destination) is the
one materialization path, and it reuses the ordinary progress/cancel protocol.

Packing is the reverse and deliberately minimal: a streaming zip writer,
writing to a `.part` file that's renamed into place on success and removed on
cancellation, so a failed pack never leaves a half-archive that looks whole.

## The shared editor (Buffers linkage)

The read-only code preview is Buffers' editor, not a copy of it. Two shim
files (`src/editor-core.ts`, `src/langs.ts`) re-export from the sibling
checkout — `export * from "../../Buffers/src/…"` — so both apps render code
from the same source file, and a fix in one is a fix in both.

This linkage imposes three constraints to know before touching it:

1. The Buffers originals must stay **dependency-closed** (CodeMirror imports
   only — no app state, no app types), or Delight's build breaks.
2. Both repos must be checked out side by side, and both must have their npm
   dependencies installed — module resolution for the re-exported files walks
   up from *Buffers'* directory and never reaches Delight's `node_modules`.
3. CodeMirror must resolve to a **single instance**. Its facets and syntax-tree
   node types compare by identity; two copies of `@lezer/common` silently
   break highlighting. `vite.config.ts` pins every CodeMirror/Lezer package to
   an absolute path in Delight's own `node_modules` via `resolve.alias`.

The shims are re-exports rather than git symlinks because Windows checkouts
can't materialize symlinks without elevated privileges; a re-export behaves
identically on every OS. Details and failure modes are in CLAUDE.md.

## Platform partitioning

Every OS difference lives in one of five places, and nowhere else: the
frontend's `platform.ts` (`isMac`, `MOD` — the only OS branch in TypeScript),
a `.mac` class on the root element for macOS-only chrome CSS, `#[cfg]` blocks
in Rust for native capability splits, per-OS `tauri.<os>.conf.json` overlays,
and `scripts/prebuild.mjs` for platform build steps. The rule exists so that
porting means working through one checklist instead of hunting `if (mac)`
through feature code, and CLAUDE.md tracks the per-feature status table.

Where an OS lacks a capability (system icons and the Quick Look panel outside
macOS, rwx permissions on Windows), the command returns `None` and the UI
degrades to its built-in equivalent — stubs, not errors.

## Persistence

Two files in the app's config directory, both written atomically:

- `settings.json` — everything the frontend persists (settings, tabs, pane
  paths, favorites, keybindings, column spec), as one JSON blob whose schema
  the frontend owns. The backend just stores it.
- `.window-state.json` — window bounds, managed by `tauri-plugin-window-state`.

First launch (no window state) sizes the window to 80% of the screen and
centers it. The window starts hidden and the frontend reveals it after its
first painted frame, so launch never flashes an unstyled white webview.

## Testing

The browser mock is the harness of first resort: `pnpm dev`, drive the UI in
a browser (the mock includes a 10k-entry directory, symlinks, a
permission-denied directory, dotfiles, and archives). `tsc` and `cargo check`
gate every change; `cargo test` covers the backend's pure logic — archive
parsing and traversal, pack/unpack round-trips, metadata restoration.

What the mock can't verify: real OS drag-out, thumbnails, Quick Look, TCC
permission prompts, and anything driven by `requestAnimationFrame` while the
tab is backgrounded (the marquee auto-scroll). Those need the native app and,
usually, a human.

## Build and release

`pnpm tauri build` produces `Delight.app` on macOS (self-signed — which keeps
TCC permission grants across rebuilds, and equally means Gatekeeper on *another*
Mac will refuse it until the quarantine attribute is cleared), a standalone `delight.exe` plus an
NSIS installer on Windows, and a `.deb` plus an AppImage on Linux
(`tauri.linux.conf.json`). GitHub Actions builds the Windows and Linux releases
on version tags, in parallel: each job checks out both repos (the editor linkage
above), installs both dependency trees, builds, and uploads versioned and
stable-named binaries with checksums; a final job collects them into one draft
GitHub Release. The stable names exist so
`releases/latest/download/…` links stay valid across versions. macOS release
builds are made on a Mac and uploaded to the same release — CI runners can't
hold the local signing key, and macOS runner minutes bill at ten times the
Linux rate.

## Sharp edges

The complete list lives in CLAUDE.md's Gotchas section and is worth reading
before deep work. The ones most likely to surprise:

- Editing the shared-editor shims instead of the Buffers originals (changes
  vanish — the shims are one-line re-exports).
- Breaking the single-CodeMirror-instance rule when touching dependencies
  (highlighting silently no-ops rather than erroring).
- Assuming `..` behaves like a normal row (it's excluded from selection,
  chips, and pack sources by design, in several places).
- Writing filesystem code outside `ops.rs` (the read/write split is what
  keeps mutations auditable; keep it).
