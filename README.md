# mesgia-relay

Relais permanent entre la messagerie Mesgia et un cerveau éphémère (LLM CLI).

- **Réception** : webhook HMAC de Mesgia (signature `X-Mesgia-Signature`, fenêtre 5 min), exposé publiquement via le tunnel Cloudflare `relay.explodev.fr`.
- **Cerveau** : `kimi -p` invoqué en non-interactif (`--output-format stream-json`), avec `spawn` sans shell (le message est une donnée non fiable).
- **Réponse** : **signée CBOR-Web (EIP-191)** via `POST /api/cbor-web/messages`, sous l'identité d'un wallet Ethereum — pas de clé API.

Dépendances : Node ≥ 24, `cloudflared`, `@noble/curves` + `@noble/hashes` (secp256k1 + keccak, pures JS). Le reste est de la stdlib.

## 1. Configuration `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Variables requises :

- `MESGIA_API` — URL de Mesgia (ex. `https://mesgia.explodev.workers.dev`)
- `MESGIA_WEBHOOK_SECRET` — HMAC des webhooks sortants de Mesgia (même secret que `webhook_secret` en D1)
- `MESGIA_WALLET_KEY` — clé privée Ethereum (64 hex) du relais, identité M2M
- `RELAY_PORT` (défaut 8787), `BRAIN_BIN` (défaut `~/.kimi-code/bin/kimi`), `BRAIN_TIMEOUT_MS` (défaut 120000)

Ne jamais committer `.env`.

## 2. Identité M2M

Le relais doit être enregistré comme agent CBOR-Web (wallet obligatoire) avec son adresse publique :

```bash
node --input-type=module -e "
import { register } from './src/cbor-client.mjs';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()]}));
import { deriveAddress } from './src/cbor-client.mjs';
const r = await register({ api: env.MESGIA_API, wallet: deriveAddress(env.MESGIA_WALLET_KEY), displayName: 'Relais-Kimi-M2M', privateKey: env.MESGIA_WALLET_KEY, webhookUrl: 'https://relay.explodev.fr', isPublic: true });
console.log(JSON.stringify(r));
"
```

L'enregistrement retourne le `participant_id` et positionne `webhook_url` + `is_public` (zéro opération manuelle en base).

## 3. Démarrer

```bash
node relay.mjs
# ou via le tunnel nommé :
cloudflared tunnel --no-autoupdate run --token "$(cat ~/.cloudflared/relay-token.txt)" --url http://localhost:8787
```

`relay.mjs` écoute sur `127.0.0.1:8787`. `GET /healthz` → `{ ok: true }`.

## 4. Arrêter

```bash
kill $(pgrep -f "node relay.mjs")
```

## 5. Tests

```bash
node --test test/*.test.mjs
```

## ⚠️ Avertissement

La conversation de test doit contenir **le relais + un humain uniquement** : le POST entrant re-dispatche la réponse aux autres agents IA de la conversation, sinon ping-pong entre agents.
