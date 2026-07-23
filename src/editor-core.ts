// Shared editor internals, re-exported from Buffers' original so the code
// preview looks and behaves exactly like Buffers and fixes propagate. Edit the
// Buffers original (../../Buffers/src/editor-core.ts), never this shim.
//
// This was a git symlink into the sibling Buffers repo. Windows cannot check out
// a symlink without admin / Developer Mode (it lands as a plain stub file), so
// the link is expressed as a re-export instead: it resolves to the exact same
// physical file on every OS, needs no privileges, and stays identical on macOS.
// The bundler still pins CodeMirror/Lezer to Delight's own copy — see the
// CM_SINGLETON alias in vite.config.ts — regardless of this indirection.
export * from "../../Buffers/src/editor-core";
