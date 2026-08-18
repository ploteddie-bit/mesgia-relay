#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${RELAY_PORT:-8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERREUR : cloudflared absent. Installer :" >&2
  echo "  mkdir -p ~/.local/bin && curl -L -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared" >&2
  exit 1
fi
[ -f .env ] || { echo "ERREUR : .env absent (copier .env.example)." >&2; exit 1; }
[ -f "$HOME/.cloudflared/relay-token.txt" ] || { echo "ERREUR : $HOME/.cloudflared/relay-token.txt absent (token tunnel nommé)." >&2; exit 1; }

node relay.mjs >> relay.log 2>&1 &
echo $! > relay.pid

cflog="$(mktemp /tmp/mesgia-relay-cf.XXXXXX.log)"
cloudflared tunnel --no-autoupdate run --token "$(cat "$HOME/.cloudflared/relay-token.txt")" --url "http://localhost:$PORT" >> "$cflog" 2>&1 &
echo $! > cloudflared.pid

# Tunnel nommé : hostname FIXE relay.explodev.fr (déjà dans l'allow-list prod)
HOST="relay.explodev.fr"
url=""
for _ in $(seq 1 30); do
  if curl -s -m 2 "https://$HOST/healthz" | grep -q '"ok":true' 2>/dev/null; then
    url="https://$HOST"
    break
  fi
  sleep 1
done
if [ -z "$url" ]; then
  echo "ERREUR : tunnel $HOST non opérationnel (log : $cflog)" >&2
  exit 1
fi

echo ""
echo "=== RELAIS EN LIGNE ==="
echo "URL fixe (déjà dans l'allow-list prod) : $url"
echo "Log cloudflared : $cflog"
