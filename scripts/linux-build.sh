#!/bin/sh
# Build the Linux .deb + AppImage in a container, so the GTK/WebKitGTK dev
# packages never touch the host. Output: target/linux-docker/release/bundle/.
# Extra args go to `pnpm tauri build` (e.g. --debug). Needs ../Buffers checked
# out beside this repo, like every other build.
set -eu
cd "$(dirname "$0")/.."
docker build -q -t delight-linux-build -f scripts/linux-build.Dockerfile scripts
# Caches (cargo registry, pnpm store) live under target/linux-docker/ so they
# persist between runs; node_modules get anonymous volumes so the host's
# (built against a different glibc) are never touched. The container runs as
# root, so the files it wrote are handed back to the invoking user at the end.
docker run --rm -t \
  -v "$PWD:/work/delight" -v "$PWD/../Buffers:/work/Buffers" \
  -v /work/delight/node_modules -v /work/Buffers/node_modules \
  -e CARGO_TARGET_DIR=/work/delight/target/linux-docker \
  -e CARGO_HOME=/work/delight/target/linux-docker/cargo \
  -w /work/delight delight-linux-build \
  sh -euc '
    trap "chown -R $0 target/linux-docker dist 2>/dev/null || true" EXIT
    store=/work/delight/target/linux-docker/pnpm-store
    (cd ../Buffers && pnpm install --frozen-lockfile --store-dir $store)
    pnpm install --frozen-lockfile --store-dir $store
    pnpm tauri build "$@"
  ' "$(id -u):$(id -g)" "$@"
