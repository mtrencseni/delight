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

// Tauri expects a fixed dev port; don't auto-increment.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    // The symlinked editor-core.ts / langs.ts realpath is outside Delight's root,
    // so the dev server must be allowed to serve from there.
    fs: { allow: [".", "../Buffers"] },
  },
  build: { target: "es2022" },
  resolve: {
    alias: CM_SINGLETON_PACKAGES.map((name) => ({ find: name, replacement: dep(name) })),
    dedupe: CM_SINGLETON_PACKAGES,
  },
});
