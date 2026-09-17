#!/usr/bin/env bash
# Runs the jsdom end-to-end test for the workbench UI.
#
#   ./tools/run-ui-e2e.sh /path/to/dbx-plugin-http-client
#
# The UI is loaded into jsdom exactly the way the DBX dev host loads it (local
# <script src> inlined into the document), wired to the real Go sidecar through a
# mock Host Bridge, and then driven like a user. `tools/test-target-server.py` is
# started automatically and shut down afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR="${1:-$ROOT/dist/dbx-plugin-http-client}"
PORT="${PORT:-18080}"
SCRATCH="${SCRATCH:-$ROOT/.uitest}"

if [[ ! -x "$SIDECAR" ]]; then
  echo "sidecar binary not found or not executable: $SIDECAR" >&2
  echo "build it first, e.g.  go build -o dist/dbx-plugin-http-client ./backend" >&2
  exit 1
fi

if [[ ! -d "$SCRATCH/node_modules/jsdom" ]]; then
  echo "installing jsdom into $SCRATCH ..."
  mkdir -p "$SCRATCH"
  ( cd "$SCRATCH" && npm install --no-fund --no-audit jsdom@^30 >/dev/null )
fi

python3 "$ROOT/tools/test-target-server.py" &
TARGET_PID=$!
trap 'kill "$TARGET_PID" 2>/dev/null || true' EXIT

# Give the fixture a moment to bind the port before the first request goes out.
for _ in $(seq 1 40); do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/users"; then break; fi
  sleep 0.25
done

cd "$SCRATCH"
# Node resolves `import "jsdom"` relative to the script's own directory, not the
# cwd, so the harness has to live next to the installed node_modules.
cp "$ROOT/tools/ui-e2e-test.mjs" "$SCRATCH/ui-e2e-test.mjs"
UI_DIR="$ROOT/ui" SIDECAR="$SIDECAR" BASE="http://127.0.0.1:$PORT" \
  node "$SCRATCH/ui-e2e-test.mjs"
