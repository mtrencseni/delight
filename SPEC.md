# Spec: **Delight Commander** ("Delight") — dual-pane file manager, v0.1 (Mac-only, read-only)

## Naming & identity
- **Product name:** Delight Commander. **Short name:** Delight. Window title: `Delight`.
- **Identifiers:** app id `com.trencseni.delight` (Tauri `identifier`), binary/crate `delight`, repo `delight-commander` (or `delight`).
- macOS bundle: `Delight.app`, `productName: "Delight"` in `tauri.conf.json`.
- No logo/icon design in v0.1 — use the default Tauri icon or a placeholder SVG "D"; a real icon is a later task.
- **The name is a design principle:** when in doubt, choose the option that feels more *delightful* — snappy, subtle animations (~100–150ms, never sluggish), zero jank, keyboard-first, no modal interruptions, friendly empty/error states. If a feature can't be made to feel good in v0.1, cut it rather than ship it clunky.

## What this is
v0.1 of **Delight Commander**, a Total Commander-style dual-pane file manager. This version exists only to validate: the Tauri build flow on macOS, the app's look'n'feel, and the architectural skeleton. It is **read-only** — it never modifies the filesystem. No copy/move/delete/rename in this version.

## Stack (decided, don't relitigate)
- **Tauri 2.x** (Rust backend + WKWebView frontend on macOS).
- Frontend: **TypeScript + Vite**. Framework: your call (Svelte, React, or vanilla — pick what yields the least code; no heavy UI kits).
- Package manager: **pnpm**. Dev loop: `pnpm tauri dev`. Build: `pnpm tauri build` (unsigned .app is fine for v0.1).
- All FS access via **Rust commands** (`#[tauri::command]`) — the webview never touches the FS directly. Commands are async; directory listing must not block the UI.

## Cross-platform discipline (baked in from day 1, even though v0.1 is Mac-only)
- Rust: `std::path::PathBuf` everywhere; no hardcoded `/`; no POSIX-only assumptions without a `#[cfg(unix)]` fence and a stubbed Windows branch.
- Abstract "filesystem roots": on Mac it's `/` (plus /Volumes entries later); design the type so Windows drive letters (`C:\`, `D:\`) slot in without refactoring.
- **No native OS look emulation** — Delight has its own single design on all platforms:
  - Bundle a webfont (e.g. Inter) — never rely on system fonts.
  - All icons are **inline SVG** (crisp at any zoom) — no emoji, no OS glyphs, no raster images.
  - Custom-styled scrollbars and controls (no native checkboxes/selects).
  - Standard OS window chrome is fine for v0.1 (no frameless/custom titlebar yet).

## Features

### 1. Dual-pane directory listing (read-only)
- Two side-by-side panes, each showing one directory. Start both at `$HOME`.
- Columns: **Name** (with type icon: folder/file/symlink), **Size** (human-readable; blank or `<DIR>` for dirs), **Modified** (local time, `YYYY-MM-DD HH:mm`), **Ext** (separate column, TC-style).
- Sort by clicking column headers (toggle asc/desc; default: dirs-first, then name, case-insensitive).
- Navigation: double-click or Enter opens a directory; `..` entry at top (and Backspace) goes up; each pane shows its current path (editable text field: type a path + Enter to jump; invalid path → subtle inline error, stay put).
- One pane is "active" (focus ring / highlighted path bar); Tab switches active pane. Arrow keys move the cursor row in the active pane.
- Symlinks: show with a distinct icon variant; don't break on unresolvable targets.
- Unreadable dirs (permissions): show an inline non-modal error in the pane, keep previous listing.
- Perf guard: listing returned by Rust as one batch; must stay responsive on a 10k-entry dir (virtualized rows if the chosen framework doesn't handle it).

### 2. Hidden files toggle
- Global toggle (both panes): show/hide dotfiles. Shortcut **Cmd+Shift+.** (same as Finder), plus a toolbar button. Persisted.
- macOS-hidden-flag files: out of scope; dotfile rule only for v0.1.

### 3. Zoom (browser-style)
- **Cmd+Plus / Cmd+Minus / Cmd+0** → zoom UI in/out/reset. Steps like a browser (e.g. 0.5–2.0, ~10 levels through 100%).
- Implement as a root-level scale (CSS `zoom` or root `font-size` with everything in `rem`) — everything scales: text, SVG icons, paddings, rows. This is why vector-only assets are mandatory.
- Zoom level persisted; show current % transiently (e.g. brief toast) when it changes.

### 4. Tabs (browser-style)
- Tab strip across the top; each tab holds its own dual-pane state (both paths, sorts, cursor).
- **Cmd+T** new tab (clones current tab's paths), **Cmd+W** close tab (never closes last tab), **Cmd+Shift+[ / ]** or Ctrl+Tab to switch. Click to activate; middle-click closes. New-tab (+) button.
- Tab title: active pane's directory basename.
- Tabs persisted across restart (paths only; graceful fallback to `$HOME` if a path no longer exists).

### 5. Settings — opens in a tab (like a browser)
- **Cmd+,** opens a Settings *tab* (reuses the tab system; it's a tab whose content is the settings page, title "Settings"; only one settings tab at a time — re-invoking focuses it).
- v0.1 settings: **Theme** (Light / Dark / System), **Show hidden files** (mirrors the toggle), **Default zoom**. That's it — but structure the page so adding sections later is trivial.
- Persistence: single JSON settings file via Tauri's app-config dir (e.g. `tauri-plugin-store` or hand-rolled). Settings apply live, no restart.

### 6. Light/dark mode
- Three-way: Light / Dark / **System** (follows macOS appearance, live-updates on OS switch).
- Implement as CSS custom-property theme tokens on the root — every color in the app comes from a token; no hardcoded colors in components. (This is the foundation for future theming; get it right now.)

## Non-goals for v0.1 (explicitly out)
Any FS mutation; file opening/preview (Enter on a *file* does nothing — v0.1); drag-and-drop of any kind; context menus; search/filter; Windows/Linux builds; signing/notarization; auto-update; custom titlebar; real app icon; file icons from the OS (use our own generic SVG set: folder / file / symlink is enough).

## Acceptance criteria
1. `pnpm tauri dev` runs on macOS; `pnpm tauri build` produces a launchable `Delight.app`.
2. Browse anywhere the user can read, incl. large dirs (10k entries) without jank.
3. All shortcuts work: Cmd+T/W, tab switching, Cmd+Plus/Minus/0, Cmd+Shift+., Cmd+,, Tab (pane switch), arrows/Enter/Backspace.
4. Zoom scales the entire UI crisply (no blurry assets) and persists.
5. Theme switching (incl. System) is instant and complete — no unthemed elements.
6. Tabs + settings + hidden-files + zoom all survive an app restart.
7. Path-separator audit passes: no hardcoded `/` in Rust path logic; Rust compiles with no `unix`-only code outside `#[cfg]` fences.
8. Delight never writes to any user file (its own settings/config dir only).

## Suggested first milestones (in order)
1. Scaffold Tauri 2 + Vite + TS; window opens with themed shell, titled "Delight".
2. Rust `list_dir` command (entries + metadata, hidden-flag, error handling) + one pane rendering it.
3. Dual panes + navigation + sorting + active-pane model.
4. Tabs.
5. Zoom.
6. Settings tab + persistence + theming.
7. Polish pass against acceptance criteria — does it *delight*?
