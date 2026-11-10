#!/bin/bash
# Build Happy.app from this checkout and install it to /Applications.
#   scripts/package-app.sh            build, then quit Happy, install and reopen
#   scripts/package-app.sh build      build only (release/mac-arm64/Happy.app)
#   scripts/package-app.sh install PID  wait for PID to exit, install the built app and reopen it
# "Update & restart" in Settings runs `build` while Happy keeps running, then `install <its pid>` detached.
# `build` also pulls new commits (if this checkout tracks a remote and is clean) and installs dependencies when needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILT="$ROOT/release/mac-arm64/Happy.app"
DEST="/Applications/Happy.app"
cd "$ROOT"

build() {
  # Pick up new commits when this checkout tracks a remote and has no local edits (a shared install's updates).
  if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1 && [ -z "$(git status --porcelain)" ]; then
    git pull --ff-only || echo "git pull failed; building what's here" >&2
  fi
  # Install or refresh dependencies when they're missing or the lockfile changed.
  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm install --no-audit --no-fund
  fi
  npm run build
  npx electron-builder --mac dir --arm64 -c.extraMetadata.happySource="$ROOT" --publish never
  test -d "$BUILT"
}

install() {
  local pid="${1:-}"
  if [ -n "$pid" ]; then
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
  elif pgrep -xq Happy; then
    osascript -e 'tell application "Happy" to quit' || true
    for _ in $(seq 1 50); do pgrep -xq Happy || break; sleep 0.2; done
  fi
  rm -rf "$DEST.new"
  ditto "$BUILT" "$DEST.new"
  rm -rf "$DEST.old"
  [ -d "$DEST" ] && mv "$DEST" "$DEST.old"
  mv "$DEST.new" "$DEST"
  rm -rf "$DEST.old"
  open "$DEST" --args --relaunched
}

case "${1:-all}" in
  build) build ;;
  install) install "${2:-}" ;;
  all) build && install ;;
  *) echo "usage: $0 [build|install PID]" >&2; exit 2 ;;
esac
