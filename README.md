# Delight Commander

A Total Commander–style **dual-pane file manager** that tries to live up to its
name: fast, keyboard-first, no jank, with its own clean design (not a native
look-alike).

> **v0.1 — macOS. Strictly read-only:** Delight never creates, moves, renames,
> or deletes your files. The only thing it writes is its own settings.

![Delight Commander](docs/screenshot.png)

## Features

**Browsing**
- Two independent panes with tabs (Chrome-style: drag to reorder, middle-click to close).
- Three views per pane, switchable with **⌘L / ⌘C / ⌘I**:
  - **List** — sortable, resizable, reorderable columns.
  - **Chips** — the selected item expands into a rich detail card; **Bigger chips**
    (the default) gives it a large content preview with the details beside it. The
    compact rows share the list's exact columns, so switching list↔chips doesn't shift anything.
  - **Icons** — a grid with Finder-style selection and **rubber-band (marquee)
    selection**: drag across empty space to select, auto-scrolling at the edges.
- Finder-style disclosure triangles: expand a folder inline as a tree without leaving the pane.
- Editable path bar — type a path and press Enter. Open folders **auto-refresh** when their contents change on disk.

**Selecting & sorting**
- Multi-select: click, **Shift-click** for a range, **⌘/⌃-click** to toggle, **Shift+↑/↓** to extend, **⌘A** to select all.
- Sort by clicking a header or with **⌘N / ⌘E / ⌘S / ⌘⇧C / ⌘M** (name / ext / size / created / modified). Optionally keep both panes in sync.
- Optional **Created** and **Permissions** columns. Column order and widths are **one
  global spec** — reorder or resize in any pane and every pane and tab follows.

**Working with files**
- **Double-click / Enter** a file → opens in the default app. **Space** → a live preview in the opposite pane (or a Finder Quick Look window — your choice); the preview pane **stays open across folder changes**, tracking the cursor like Finder.
- **Preview icons** (optional, Finder-style): show real content thumbnails in list & icon views, at your chosen resolution — shared with the Space preview so they load once.
- **Drag files out** of Delight into Finder, Mail, or any app (a copy — never a move).
- **Favorites** dropdown per pane (**⌘1** / **⌘2**), keyboard-navigable and drag-reorderable. Your Dropbox folder is added automatically if you have one.

**Polish**
- Light / dark / system themes, browser-style zoom, show/hide dotfiles.
- Size bars behind file sizes (linear or logarithmic), recency tint (**Now / today / yesterday**), optional real macOS file icons.
- Keyboard navigation suppresses the mouse-hover highlight, so only the cursor row reads as active.
- Display all names in original / lowercase / UPPERCASE.
- **Fully configurable keyboard shortcuts** in a dedicated Shortcuts tab.
- Remembers window size and position; opens at 80% of the screen the first time.

## Install & run

Requires [Node](https://nodejs.org) + [pnpm](https://pnpm.io) and the
[Rust toolchain](https://www.rust-lang.org/tools/install).

```sh
pnpm install
pnpm tauri dev      # run the native app with hot-reload
pnpm dev            # browser-only UI against a mock filesystem (no native shell)
```

Build a distributable app:

```sh
pnpm tauri build    # → src-tauri/target/release/bundle/macos/Delight.app
```

## Keyboard shortcuts

All shortcuts are rebindable in **Settings → Keyboard → Configure shortcuts**.
Defaults:

| Keys | Action |
| --- | --- |
| ⌘T / ⌘W | New / close tab |
| ⌘⇧[ · ⌘⇧] · ⌃⇥ · ⌘` | Switch / cycle tabs (skips Settings) |
| ⌘L / ⌘C / ⌘I | List / Chips / Icons view |
| ⌘, | Settings |
| Tab | Switch active pane |
| ↑ ↓ · PgUp PgDn · Home End · ⌘↑ ⌘↓ | Move cursor / jump to top / bottom |
| → ← | Expand / collapse folder (list view) |
| ⇧↑ / ⇧↓ · ⌘A | Extend selection / select all |
| Enter · double-click | Open (folder or default app) |
| Backspace | Go up a folder |
| Space | Preview |
| ⌘1 / ⌘2 | Favorites — left / right pane |
| ⌘N ⌘E ⌘S ⌘⇧C ⌘M | Sort by name / ext / size / created / modified |
| ⌘+ ⌘− ⌘0 | Zoom in / out / reset |
| ⌘⇧. | Show / hide hidden files |
| ⌥⌘I | Developer tools (when enabled) |

## Privacy & data

- **Read-only.** Delight never modifies your files.
- Its own settings (open tabs, favorites, shortcuts, window size, …) live in a
  single JSON file at
  `~/Library/Application Support/com.trencseni.delight/settings.json`
  (plus `.window-state.json`). It writes nowhere else.
- The first time you browse into a protected folder (Downloads, Documents, …),
  macOS asks for permission once, as it does for any app.

## Platform support

v0.1 targets **macOS**. The codebase is written with cross-platform discipline
(portable paths, feature fences), so **Windows and Linux** are planned — some
OS-specific features (Quick Look previews, system icons) will degrade gracefully
or need platform equivalents. See [CLAUDE.md](CLAUDE.md) for the details.

## Tech

Tauri 2 (Rust backend + WKWebView) with a vanilla TypeScript / Vite frontend.
All filesystem access goes through Rust commands — the webview never touches the
disk. See [CLAUDE.md](CLAUDE.md) for architecture and [SPEC.md](SPEC.md) for the
original v0.1 spec.
