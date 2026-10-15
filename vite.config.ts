import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Absolute path to one of Delight's own installed packages, so we can pin every
// CodeMirror/Lezer import to a SINGLE physical copy (see resolve.alias below).
const dep = (name: string) => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

// The read-only code preview reuses Buffers' editor via the symlinked
// src/editor-core.ts + src/langs.ts. Those files' realpath is in the sibling
// Buffers repo, so their bare CodeMirror/Lezer imports would otherwise resolve
// from Buffers' node_modules — a SECOND copy of @lezer/common / @codemirror/state,
// etc. CodeMirror is identity-based (facets, and the parser's syntax-tree node
// types), so a second @lezer/common makes the parser's tree unrecognizable to the
// highlighter and syntax coloring silently no-ops (dedupe/optimizeDeps.include did
// NOT collapse it across the symlink's realpath). Aliasing each shared package to
// an ABSOLUTE path in Delight's own tree forces exactly one instance, applied even
// during dep pre-bundling. (Delete node_modules/.vite after changing this.)
const CM_SINGLETON_PACKAGES = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
  "@codemirror/commands",
  "@codemirror/search",
  "@codemirror/autocomplete",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@replit/codemirror-minimap",
];

// Two targets out of one source (see src/target.ts):
//
//   vite build              -> dist/     the Tauri webview bundle
//   vite build --mode web   -> dist-web/ the bundle delight-server serves
//
// `pnpm dev` stays on the mock; `pnpm dev:web` runs the web build against a
// locally running server, proxying the API so the browser still sees one origin
// (which is the whole reason the web build can use fetch() at all).
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  const server = process.env.DELIGHT_SERVER ?? "http://127.0.0.1:8070";
  return {
  clearScreen: false,
  server: {
    // Tauri expects a fixed dev port; don't auto-increment. The web dev server
    // gets its own so both can run at once.
    port: web ? 1421 : 1420,
    strictPort: true,
    // Cargo builds under target/ at the workspace root (src-tauri/target is the
    // pre-0.3 location); its registry cache alone has more files than the
    // default inotify budget.
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    // The symlinked editor-core.ts / langs.ts realpath is outside Delight's root,
    // so the dev server must be allowed to serve from there.
    fs: { allow: [".", "../Buffers"] },
    proxy: web
      ? Object.fromEntries(
          ["/api", "/login", "/logout", "/ping"].map((p) => [p, { target: server, changeOrigin: false }])
        )
      : undefined,
  },
  build: { target: "es2022", outDir: web ? "dist-web" : "dist" },
  resolve: {
    alias: CM_SINGLETON_PACKAGES.map((name) => ({ find: name, replacement: dep(name) })),
    dedupe: CM_SINGLETON_PACKAGES,
  },
  };
});
