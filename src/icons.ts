// All iconography is inline SVG on currentColor — crisp at any zoom level.
const svg = (body: string, stroke = true) =>
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" ${
    stroke
      ? 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"'
      : 'fill="currentColor"'
  }>${body}</svg>`;

const FILE_OUTLINE = '<path d="M4 2.75c0-.55.45-1 1-1h4.25l3 3v8.5c0 .55-.45 1-1 1H5c-.55 0-1-.45-1-1V2.75Z"/><path d="M9.1 1.9v3h3"/>';

export const icons = {
  // Finder-style folder: filled body with a lighter front panel.
  folder: svg(
    '<path d="M1.5 4.35c0-.6.49-1.1 1.1-1.1h3.1c.33 0 .64.15.85.4l.75.9h6.05c.6 0 1.1.49 1.1 1.1v5.9c0 .6-.49 1.1-1.1 1.1H2.6a1.1 1.1 0 0 1-1.1-1.1V4.35Z"/><path d="M1.5 6.55c0-.6.49-1.1 1.1-1.1h10.8c.6 0 1.1.49 1.1 1.1v4.5c0 .6-.49 1.1-1.1 1.1H2.6a1.1 1.1 0 0 1-1.1-1.1v-4.5Z" fill="#fff" opacity=".2"/>',
    false
  ),
  file: svg(FILE_OUTLINE),
  symlink: svg(
    '<path d="M13.5 9.25v3c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25h3"/><path d="M9.5 2.5h4v4"/><path d="M13.2 2.8 7.5 8.5"/>'
  ),
  up: svg('<path d="M8 13V4.5"/><path d="M4.5 8 8 4.5 11.5 8"/>'),
  eye: svg(
    '<path d="M1.5 8s2.5-4.25 6.5-4.25S14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/>'
  ),
  // A true cog silhouette (24-unit viewBox) so it reads as a gear, not a sun.
  gear:
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  sun: svg(
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/>'
  ),
  moon: svg('<path d="M13.4 9.5A5.5 5.5 0 0 1 6.5 2.6a5.5 5.5 0 1 0 6.9 6.9Z"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  sortAsc: svg('<path d="M4.5 9.5 8 6l3.5 3.5"/>'),
  sortDesc: svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>'),
  chevron: svg('<path d="m6 3.75 4.25 4.25L6 12.25" stroke-width="1.6"/>'),
  viewList: svg(
    '<path d="M6 4.2h8M6 8h8M6 11.8h8"/><rect x="2" y="3.2" width="2" height="2" rx="0.5"/><rect x="2" y="7" width="2" height="2" rx="0.5"/><rect x="2" y="10.8" width="2" height="2" rx="0.5"/>'
  ),
  viewGrid: svg(
    '<rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1"/>'
  ),
  bookmarks: svg('<path d="M4 2.5h8v11l-4-2.6-4 2.6z"/>'),
  house: svg('<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 6.9V13h8V6.9"/>'),
};

// ---- filetype icons ---------------------------------------------------------

const typeIcons: Record<string, string> = {
  image: svg(
    '<rect x="2.5" y="3.25" width="11" height="9.5" rx="1.4"/><circle cx="6" cy="6.6" r="1.05"/><path d="m4.2 11.5 2.7-3.1 1.9 2.1 1.8-2.2 2.3 3.2"/>'
  ),
  video: svg(
    '<rect x="2.5" y="3.25" width="11" height="9.5" rx="1.4"/><path d="M6.9 6.1v3.8L10.2 8 6.9 6.1Z" fill="currentColor" stroke="none"/>'
  ),
  audio: svg(
    '<path d="M6.2 12.3V4.6l6-1.4v7.4"/><circle cx="4.6" cy="12.3" r="1.55"/><circle cx="10.6" cy="10.6" r="1.55"/>'
  ),
  archive: svg(
    '<rect x="3" y="2.75" width="10" height="10.5" rx="1.4"/><path d="M8 2.75v1.5M8 6v1M8 8.75v1"/>'
  ),
  code: svg(
    '<path d="m5.2 5.6-2.7 2.4 2.7 2.4"/><path d="m10.8 5.6 2.7 2.4-2.7 2.4"/><path d="M9.1 3.9 6.9 12.1"/>'
  ),
  doc: svg(FILE_OUTLINE + '<path d="M6 8h4M6 10.2h4"/>'),
  pdf: svg(FILE_OUTLINE + '<path d="M5.9 9.4h4.2" stroke-width="2"/>'),
  exec: svg(
    '<rect x="2.5" y="3" width="11" height="10" rx="1.4"/><path d="m4.9 6.3 2 1.7-2 1.7"/><path d="M8.4 10.3h2.7"/>'
  ),
};

const EXT_CATEGORY: Record<string, string> = {};
const cat = (c: string, exts: string) => {
  for (const e of exts.split(" ")) EXT_CATEGORY[e] = c;
};
cat("image", "png jpg jpeg gif webp svg heic heif bmp tiff tif ico icns avif raw");
cat("video", "mp4 mov mkv avi webm m4v mpg mpeg wmv flv");
cat("audio", "mp3 wav aac flac ogg m4a aiff alac mid");
cat("archive", "zip tar gz tgz bz2 xz zst 7z rar dmg pkg iso jar");
cat(
  "code",
  "ts tsx js jsx mjs cjs rs py rb go c cc cpp h hpp m mm java kt swift cs php sh zsh bash fish json toml yaml yml xml html htm css scss sass less vue svelte sql lua pl r"
);
cat("doc", "txt md markdown rtf doc docx pages odt tex log csv tsv xls xlsx numbers ppt pptx key epub");
cat("pdf", "pdf");
cat("exec", "app exe bin com command msi apk");

/** Icon + category class for a file extension (generic file when unknown). */
export function fileIcon(ext: string | null): { svg: string; cls: string } {
  const c = ext ? EXT_CATEGORY[ext.toLowerCase()] : undefined;
  return c ? { svg: typeIcons[c], cls: c } : { svg: icons.file, cls: "file" };
}
