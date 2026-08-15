#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for f in relay.pid cloudflared.pid; do
  if [ -f "$f" ]; then
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
done
echo "relais arrêté"
