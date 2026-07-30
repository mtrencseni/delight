# Delight Commander — product description

This document explains what Delight is, who it serves, and the reasoning behind
its design. It covers everything above the code: concepts, interface, behavior.
For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md); for the day-to-day
engineering notes, [CLAUDE.md](CLAUDE.md).

## What this is

Delight Commander is a dual-pane file manager in the Norton Commander / Total
Commander tradition, for macOS and Windows. Two directory listings sit side by
side; you work in one and act toward the other. Copy means "copy from here to
there." That one idea — an explicit source and an explicit destination, both
visible at once — is what the whole category is built on, and Delight doesn't
reinvent it. What Delight adds is a modern interpretation: the interaction
model of a 1990s orthodox file manager with the visual and input standards of
a current desktop app.

The name is a working principle, not a boast. When two designs are otherwise
equal, we pick the one that feels better in the hand: the app responds
immediately, animations are subtle and short (~120 ms), nothing blocks that
doesn't have to, and a feature that can't be made to feel good gets cut rather
than shipped clunky.

## Who it's for

People who reorganize files as a real part of their day — photographers sorting
shoots, developers shuffling build artifacts, anyone maintaining an archive or
a NAS — and who find Finder and Explorer mouse-bound for that work. The target
user keeps both hands on the keyboard, thinks in terms of "this pane, that
pane," and measures a file manager by how few gestures a move takes. Total
Commander users should feel at home; Finder users should find nothing alien,
only more direct.

## The mental model

**Panes.** Two independent directory listings. One is active (its path bar is
highlighted); Tab switches. The inactive pane is the default destination for
copy and move. A single-pane mode (⌘P) collapses to one listing with a fixed
Favorites sidebar on the left, for when you're browsing rather than
transferring.

**Cursor and marks.** The cursor is where you are; marks are what you've
selected. They're separate, as in Total Commander: you can mark five files in
red, then move the cursor elsewhere without losing them. Marking works by
Shift/⌘-click, Shift+arrows, ⌘A, right-click or a right-button drag across
rows (the classic Commander gesture), and a rubber-band marquee in icon view.
When nothing is marked, commands act on the cursor item — so quick one-file
operations never require selecting first.

**Tabs.** Each tab holds a complete dual-pane state — both paths, sorts,
cursors. They behave like browser tabs: ⌘T, ⌘W, drag to reorder, middle-click
to close. Settings and Shortcuts open as tabs too, rather than floating
dialogs, so there's exactly one windowing model in the app.

**Archives are folders.** A zip (or 7z, tar, tar.gz, …) opens like a directory:
Enter descends into it, the path bar shows the path continuing inside it,
Backspace walks back out. Inside, everything is read-only — you browse and copy
out, nothing more. This is covered in its own section below.

Shortcuts below are written mac-style; on Windows every ⌘ is Ctrl.

## A tour of the product

### Browsing

Each pane offers three views, switched with ⌘L / ⌘C / ⌘I:

- **List** — the workhorse. Sortable columns (name, extension, size, created,
  modified, permissions), each resizable and reorderable. Column layout is one
  global spec: change the order or a width anywhere and every pane and tab
  follows. That's deliberate — panes whose columns disagree make the eye
  re-parse the layout on every glance across.
- **Chips** — a list where the cursor item expands into a detail card: a large
  content preview, plus size, dates, permissions, and what app opens it. The
  compact rows share the list view's exact columns, so switching list↔chips
  moves nothing.
- **Icons** — a grid with Finder-style selection and marquee.

Folders expand in place with a disclosure triangle (→ / ←), so you can inspect
a subtree without leaving the pane; the same gesture expands an archive. The
path bar is editable — type a path, press Enter. Listings refresh on their own
when the directory changes on disk. Dotfiles and Windows-hidden files toggle
with ⌘⇧. — hidden, not gone.

Sorting is a click on a header or ⌘N/E/S/M (name, extension, size, modified,
plus ⌘⇧C for created); the two panes can
optionally keep their sort in sync. Small persistent cues carry information
without demanding attention: size bars behind the size column (linear or log),
a recency tint on files modified today or yesterday, optional real system file
icons or content thumbnails ("preview icons") at a resolution you choose.

### Finding your place

⌘F opens a find bar for the current pane: type, and the cursor jumps to the
first matching name, then cycles through matches. It deliberately does not
filter the listing — the pane keeps showing everything, so when you Escape out
you're standing exactly where the match was, with full context around it. It's
"jump to file," not "search my disk"; whole-disk search is out of scope for
now.

### Looking at files

Press Space on a file (on Windows also F3, the Commander "view" key; on macOS
plain 3) and the opposite pane becomes a preview: images
render as thumbnails, text and code open in a real read-only editor with
syntax highlighting, line numbers, a minimap, and find — the same editor its
sibling app Buffers uses, so the two render code identically. The preview
follows the cursor and survives folder changes, Finder-style; it closes when
you switch tabs or click into its pane. On macOS you can choose the system
Quick Look panel instead. Enter or double-click opens the file in its default
app.

### Acting on files

File operations use the Commander function keys — F5 copy, F6 move, ⇧F6
rename, F7 new folder, F8 delete. On macOS, where the F-key row is awkward,
the same commands sit on the plain digits: 5, 6, ⇧6, 7, 8. Three rules hold
everywhere:

1. **Destructive actions are confirmed by default.** A dialog states exactly
   what will happen ("Copy 3 items to …?"). Confirmation can be turned off in
   Settings by people who find it slows them down.
2. **Delete means Trash.** There is no hard-delete path in the product. If the
   OS can't trash something, the operation fails rather than falling back to
   permanent removal.
3. **Long operations show progress and stay cancelable.** An operation that
   outlasts a configurable delay (so quick ones never flash a dialog) shows a
   progress card with a Cancel button and a "Run in background" button that
   shrinks it to a corner panel, returning the app to you while the copy
   continues.

Dragging files out of Delight into Finder, Explorer, Mail, or any other app
always performs a copy — never a move — so a drag can't silently remove
something from its source.

### Archives

Delight reads zip (including jar, apk, docx and other zip-derived formats),
7z, tar, and the tar/bare compressor combinations (gz, bz2, xz, zst). Enter
an archive and browse it like a directory tree; F5 copies files or folders out
of it, preserving timestamps and empty directories. Password-protected zips
prompt when needed; a wrong password is never cached, so one typo can't wedge
the archive until restart.

Inside an archive the product is strictly read-only, and operations that would
require unpacking to temporary files (open in default app, thumbnails) are
unavailable rather than emulated. That's a deliberate trade: no hidden temp
directories to clean up, no stale extracted copies, no surprises about where
your data has been written.

Two write operations exist *around* archives rather than inside them: Alt+F5
(macOS: ⌥5) packs the marked items — or the cursor item — into a new zip, and
Alt+F9 (⌥9) unpacks an archive: into the opposite pane in dual-pane mode, or
into a sibling folder named after the archive in single-pane mode (`aaa.zip` →
`aaa`, then `aaa-1` if taken). One packing format, zip, no encryption: the
goal is "send someone a folder," not an archiver.

### Getting around

Each pane has a Favorites menu (⌘1 for the left pane, ⌘2 for the right) —
keyboard-navigable and drag-reorderable. You build the list yourself; the one
exception is your Dropbox folder, which is added automatically if you have
one. In single-pane mode Favorites become a permanent sidebar.

On Windows, Alt+F1 / Alt+F2 open a drive picker for the left and right pane;
typing a drive letter selects it directly. Backspace goes up; the editable
path bar goes anywhere.

### Making it yours

Every shortcut in the app is rebindable in a Shortcuts tab — recording a combo
that's already taken steals it, with a notice. ⌘K shows a drawn keyboard of
the current bindings: hold a modifier and the map switches to that layer.
Settings cover themes (light, dark, follow the OS), browser-style zoom
(⌘+/⌘−/⌘0, everything scales), display options (lowercase names, size bars,
recency tint, preview icons and their resolution), and behavior (confirmation,
progress-dialog delay, hidden files, sort sync).

## How it should feel

A few interaction rules are enforced product-wide rather than per feature:

- **Keyboard first, mouse equal.** Every operation has a shortcut; everything
  reachable by shortcut is also clickable. Keyboard navigation suppresses the
  hover highlight so only the cursor row reads as active.
- **Never block without reason.** The only modal moments are confirmations of
  destructive acts and password prompts. Everything else — progress, errors,
  empty folders — is inline and non-interrupting.
- **No jank.** Directory listings virtualize, so a 10,000-entry folder scrolls
  like an empty one. Animations stay near 120 ms and never gate an action.
- **One design everywhere.** Delight looks and behaves the same on macOS and
  Windows: same bundled font, same vector icons, same layout. It does not
  imitate the host OS. Platform conventions are honored where they're input
  conventions (⌘ vs Ctrl, function keys) rather than visual ones.

## Platforms

macOS and Windows are supported and equivalent in day-to-day use. A few
extras exist only where the OS provides them — the standalone Quick Look
panel and system file icons on macOS — and degrade to the built-in preview
and vector icons elsewhere, without layout changes. Linux is prepared for in
the code but not yet built or supported.

## What Delight is not

- **Not a network client.** SMB, FTP, SFTP and S3 have been considered and may
  come later; today Delight browses what the OS has mounted.
- **Not an archiver.** Archives open read-only; packing is zip-only, no
  encryption, no editing an archive in place.
- **Not a search engine.** ⌘F finds within the current listing. Indexing or
  recursive content search is a different product's job (or a later version's).
- **Not a terminal, editor, or IDE.** The code preview is read-only on
  purpose; editing belongs to Buffers or your editor of choice.
- **Not a native-look app.** It will never adopt Finder's or Explorer's
  visual language. One design, everywhere.

## Trust

Delight is read-mostly by construction. The only things it writes unprompted
are its own settings files. Every filesystem mutation goes through one guarded
path with confirmation on by default, delete is Trash-only, and drag-out is
copy-only. On macOS, folder-access permission prompts are the OS's own,
appearing once per protected folder as for any app.
