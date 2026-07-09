# Delight Commander

A Total Commander-style dual-pane file manager that tries to live up to its
name. **v0.1 — macOS only, strictly read-only.** See [SPEC.md](SPEC.md).

## Stack

Tauri 2 (Rust backend, WKWebView) + vanilla TypeScript/Vite frontend.
All filesystem access goes through Rust commands; the webview never touches
the FS. Outside Tauri (plain `pnpm dev` in a browser) a mock filesystem
answers, so the UI can be developed without the native shell.

## Develop

```sh
pnpm install
pnpm tauri dev     # native app + HMR
pnpm dev           # browser-only UI against the mock FS
```

## Build

```sh
pnpm tauri build   # → src-tauri/target/release/bundle/macos/Delight.app
```

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘T / ⌘W | new / close tab |
| ⌘⇧[ ⌘⇧] or ⌃Tab | switch tabs |
| ⌘, | settings tab |
| ⌘+ ⌘− ⌘0 | zoom in / out / reset to default |
| ⌘⇧. | show/hide dotfiles |
| Tab | switch active pane |
| ↑ ↓ PgUp PgDn Home End | move cursor |
| Enter / double-click | open directory |
| Backspace | go up |

Settings, tabs, zoom and the hidden-files toggle persist in a single JSON
file in the app's config dir — Delight never writes anywhere else.
