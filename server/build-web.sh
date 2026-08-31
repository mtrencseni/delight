#!/usr/bin/env bash
# Build the web UI and put it where delight-server serves it from.
#
# The server serves server/web/ (gitignored, like the binary) rather than reading
# dist-web/ directly, so a half-finished build can never be live: the swap at the
# end is the only moment anything changes.
#
# Flask-style hot pickup: asset names are content-hashed and index.html is served
# no-cache, so the next request gets the new build with no restart.
#
# The editor preview re-exports Buffers' editor from a SIBLING checkout, so that
# repo has to be present and installed too — see ARCHITECTURE.md.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d ../Buffers/src ]; then
  echo "error: ../Buffers is missing — the code preview re-exports its editor." >&2
  echo "       Clone mtrencseni/buffers next to this repo (the path is case-sensitive" >&2
  echo "       on Linux; a symlink named Buffers works)." >&2
  exit 1
fi

# corepack ships with node and reads the pnpm version from package.json, so
# there is nothing to install globally on the box.
PNPM=(corepack pnpm)
command -v pnpm >/dev/null 2>&1 && PNPM=(pnpm)

"${PNPM[@]}" install --frozen-lockfile
(cd ../Buffers && "${PNPM[@]}" install --frozen-lockfile)
"${PNPM[@]}" run build:web

rm -rf server/web.new
cp -r dist-web server/web.new
rm -rf server/web.old
[ -d server/web ] && mv server/web server/web.old
mv server/web.new server/web
rm -rf server/web.old

echo "built $(find server/web -type f | wc -l) files into server/web"
