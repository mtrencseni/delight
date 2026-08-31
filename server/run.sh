#!/usr/bin/env bash
# Supervisor for delight-server. Launch THIS rather than the binary directly, so
# a crash doesn't take the service down for good:
#
#   screen -dmS delight ./run.sh
#
# Reads server/.env (gitignored) for DELIGHT_TOKEN and anything else you want to
# set. Env:
#
#   DELIGHT_TOKEN      required — the shared secret; refuses to start without it
#   DELIGHT_ROOTS      colon-separated directories to serve (default: $HOME)
#   DELIGHT_READ_ONLY  set to refuse every file operation
#   PORT               default 8070
#   DELIGHT_WEB_DIR    the built web UI (default: server/web)
#   DELIGHT_STATE      the frontend's settings blob (default: server/state.json)
set -u
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ -z "${DELIGHT_TOKEN:-}" ]; then
  echo "[run.sh] DELIGHT_TOKEN is not set (expected in server/.env) — refusing to start." >&2
  exit 1
fi

BIN="${DELIGHT_BIN:-../target/release/delight-server}"
if [ ! -x "$BIN" ]; then
  echo "[run.sh] no binary at $BIN — run: cargo build --release -p delight-server" >&2
  exit 1
fi

export DELIGHT_WEB_DIR="${DELIGHT_WEB_DIR:-$PWD/web}"
export DELIGHT_STATE="${DELIGHT_STATE:-$PWD/state.json}"

while true; do
  "$BIN"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[run.sh] server exited cleanly — stopping supervisor."
    break
  fi
  # A crash: come back, but pace the retries so a config error can't spin.
  echo "[run.sh] server exited (code $code) — restarting in 3s…"
  sleep 3
done
