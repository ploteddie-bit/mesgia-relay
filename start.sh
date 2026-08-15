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

node relay.mjs >> relay.log 2>&1 &
echo $! > relay.pid

cflog="$(mktemp /tmp/mesgia-relay-cf.XXXXXX.log)"
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >> "$cflog" 2>&1 &
echo $! > cloudflared.pid

url=""
for _ in $(seq 1 30); do
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$cflog" | head -1 || true)"
  [ -n "$url" ] && break
  sleep 1
done
if [ -z "$url" ]; then
  echo "ERREUR : URL du tunnel non obtenue (log : $cflog)" >&2
  exit 1
fi
host="${url#https://}"

echo ""
echo "=== VALEURS À RECOLLER (quick tunnel : changent à chaque redémarrage) ==="
echo "1/2 webhookUrl de l'agent (prod)      : $url"
echo "2/2 WEBHOOK_ALLOWED_HOSTS (hostname)  : $host"
echo "Log cloudflared : $cflog"
