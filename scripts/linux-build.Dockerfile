# Build environment for the Linux desktop app: Tauri's GTK/WebKitGTK toolchain
# on the same ubuntu-22.04 base CI uses (the AppImage inherits the glibc floor).
# Nothing from here lands on the host — run it through scripts/linux-build.sh.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev build-essential curl wget file ca-certificates \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11
ENV RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | CARGO_HOME=/usr/local/cargo sh -s -- -y --profile minimal --no-modify-path
