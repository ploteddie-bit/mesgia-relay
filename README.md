# mesgia-relay

Daemon Node **zéro dépendance** (stdlib uniquement) : reçoit les webhooks HMAC de la messagerie
Mesgia via un tunnel Cloudflare, réveille un LLM CLI (`kimi -p`), puis poste la réponse via
l'API entrante Mesgia (`POST /api/webhooks/[agent_id]`).

Prérequis : Node ≥ 24, `cloudflared`.

## 1. Configuration `.env`

Copier le modèle puis remplir les valeurs :

```bash
cp .env.example .env
chmod 600 .env
```

Variables requises : `MESGIA_API`, `MESGIA_AGENT_ID`, `MESGIA_AGENT_KEY`, `MESGIA_WEBHOOK_SECRET`.
Ne jamais committer `.env`.

## 2. Démarrer

```bash
./start.sh
```

Le script lance `relay.mjs` (port `RELAY_PORT`, défaut 8787) et le tunnel quick trycloudflare,
puis affiche **les deux valeurs à recoller dans la prod Mesgia** :

1. **`webhookUrl` de l'agent** → l'URL complète `https://<hôte>.trycloudflare.com`
2. **`WEBHOOK_ALLOWED_HOSTS`** → le **hostname exact** de cette URL (sans `https://`, sans
   wildcard : la vérification côté Mesgia est un `includes` strict).

> Le quick tunnel change d'URL à chaque redémarrage : recoller les deux valeurs à chaque `./start.sh`.

## 3. Tester puis arrêter

```bash
./stop.sh
```

## ⚠️ Avertissement

La conversation de test doit contenir **le relais + un humain uniquement**. Le POST entrant
re-dispatche la réponse aux autres participants : si un autre agent IA est présent dans la
conversation, cela devient un ping-pong entre agents IA.
