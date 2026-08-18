# Review indépendante — Daemon mesgia-relay

- **Date** : 2026-08-18
- **Reviewer** : subagent indépendant (pas de vision de la conversation parente)
- **Fichiers revus** :
  - `start.sh`, `stop.sh`, `relay.mjs`, `README.md`, `package.json`, `.env.example`, `.gitignore`
  - `src/server.mjs`, `src/hmac.mjs`, `src/brain.mjs`, `src/queue.mjs`, `src/env.mjs`, `src/cbor-client.mjs`, `src/wallet.mjs`, `src/mesgia-client.mjs`
  - `test/*.test.mjs` (hmac, integration, queue, brain, cbor-client, wallet, mesgia-client)
  - `git log --oneline -6`, `git diff HEAD~1 -- start.sh`, `git status`
- **Vérifications exécutées** : `node --test test/*.test.mjs` → **29/29 tests verts** ; état des process (`relay.pid`/`cloudflared.pid` → process vivants, PPID `/init`) ; permissions `.env` (600) et `~/.cloudflared/relay-token.txt` (600) ; encodage `start.sh` (LF, pas de CRLF) ; contenu `relay.log`.

## Verdict global : **GO avec réserves**

Les fondations sécurité (HMAC timing-safe, fenêtre ±5 min, headers manquants rejetés, spawn sans shell, clé privée jamais journalisée) sont **correctes, testées et vérifiées en état réel**. La mécanique cœur (ack immédiat sans `reply`, FIFO séquentielle, fallback posté, réponse CBOR-Web signée anti-rejeu/anti-substitution) est bien implémentée et couverte par les tests.

Les réserves portent sur la **robustesse opérationnelle** (survie des process sans `nohup`/`setsid`, aucune garde de ré-exécution → pid file écrasable, `stop.sh` pouvant devenir inopérant) et sur quelques **trous de diagnostic/résilience** (stderr du cerveau jamais lue, SIGKILL sans tuer le groupe de process, `fetch` sans timeout côté post CBOR-Web, aucune reprise si le POST échoue → messages perdus). Aucun finding haute sévérité.

---

## Findings

### HIGH

Aucun finding haute sévérité. Les axes sécurité critiques demandés (clé privée wallet jamais journalisée, HMAC `timingSafeEqual`, fenêtre ±5 min, headers absents rejetés, spawn sans shell) sont tous conformes et vérifiés (voir section « Axes vérifiés sans finding »).

### MEDIUM

**M1 · brain.mjs:40-44 — SIGKILL ne tue que le process direct, pas ses enfants**
Description : au timeout, `child.kill('SIGKILL')` ne tue que le binaire `kimi`. Or `kimi -p` peut avoir spawné des sous-processus (subagents, outils).
Impact réel : après un timeout, des processus orphelins continuent de tourner (consommation CPU, appels API LLM coûteux), non visibles depuis le daemon.
Fix chirurgical : `spawn(bin, args, { stdio: [...], detached: true })` puis `process.kill(-child.pid, 'SIGKILL')` (tue le groupe) ; compléter par la lecture de stderr (cf. M2) pour logguer la raison.

**M2 · brain.mjs:40-45 — stderr du cerveau pipée mais jamais lue**
Description : `stdio: ['ignore','pipe','pipe']` + handler `.on('data')` sur `stdout` uniquement. `stderr` n'a aucun consommateur.
Impact réel : (a) buffer stderr de 64 Ko plein → le child se bloque en écrivant → timeout artificiel de 120 s ; (b) les erreurs du cerveau ne sont **jamais journalisées** : un échec remonte comme `exit code N` sans la raison, diagnostic aveugle de toutes les pannes de kimi (clé expirée, quota, crash).
Fix chirurgical : `child.stderr.on('data', d => { if (stderrLog.length < 4000) stderrLog += d })` et inclure un extrait dans le résolveur d'erreur (`exit code ${code}: ${stderrLog.slice(-500)}`).

**M3 · cbor-client.mjs:101-113 — fetch sans timeout ni AbortSignal**
Description : `fetchChallenge` et le POST `/api/cbor-web/messages` n'ont aucun signal d'abandon.
Impact réel : si l'API Mesgia est lente/hors ligne, un `postReply` peut pendre jusqu'aux timeouts par défaut d'undici (~300 s par phase) ; comme la FIFO est séquentielle, **tout le relais se bloque** pendant ce temps, les messages suivants attendent.
Fix chirurgical : ajouter un `AbortSignal.timeout(10_000)` (ou `REPLY_TIMEOUT_MS`) aux deux `fetch`, avec catch → `ok:false, error:'timeout'`.

**M4 · start.sh:14-19 — survie des process non garantie (pas de nohup/setsid/disown)**
Description : `node relay.mjs &` et `cloudflared ... &` sans `nohup`, `setsid` ni `disown` ; `set -euo pipefail` n'apporte rien ici.
Impact réel : en ce moment ça tourne (process réparentés sur `/init`, SID 197041) — mais si `start.sh` est relancé depuis un terminal interactif qui se ferme (huponexit), le relais et le tunnel meurent **silencieusement** ; le health-check suivant ne le détectera que via un curl qui échoue.
Fix chirurgical : `setsid node relay.mjs >> relay.log 2>&1 < /dev/null &` (idem cloudflared) — ou mieux, un service systemd/user avec `Restart=always`.

**M5 · start.sh:14-19 — aucune garde de ré-exécution ; pid file écrasé → stop.sh inopérant**
Description : pas de vérification de `relay.pid`/`cloudflared.pid` avant de relancer. Un second `node relay.mjs` échoue en `EADDRINUSE` — mais en arrière-plan, le code de sortie du job ne fait pas échouer le script (`set -e` ne voit pas les jobs bg) —, puis `echo $! > relay.pid` écrase le pid file avec un PID mort.
Impact réel : double démarrage furtif (relay.log montre déjà 3 « en écoute »), health-check satisfait par l'ANCIEN process → « RELAIS EN LIGNE » trompeur, et `stop.sh` ne tue plus le vrai relais (kill sur PID mort). Même schéma pour cloudflared (conflit possible sur le hostname nommé).
Fix chirurgical : en tête de `start.sh` : `if [ -f relay.pid ] && kill -0 "$(cat relay.pid)" 2>/dev/null; then echo "déjà en cours (PID $(cat relay.pid))" >&2; exit 1; fi` (idem `cloudflared.pid`).

**M6 · server.mjs:16-21 / cbor-client.mjs:132 — aucun retry si le POST CBOR-Web échoue → message perdu**
Description : si `postReply` retourne `ok:false` (fetch, HTTP 5xx, challenge), le message de l'utilisateur reste **sans réponse et sans reprise** : log « ÉCHEC post réponse » uniquement, pas de retry ni de dead-letter. Le fallback (cerveau KO) subit le même sort si le POST lui-même échoue.
Impact réel : une indisponibilité transitoire de Mesgia perd définitivement les réponses en cours (l'humain ne voit rien, ni la réponse ni le fallback).
Fix chirurgical (minimal) : 1 retry avec backoff court sur `postReply` ; ou journaliser la réponse perdue dans un fichier `dead-letters/` pour rejeu manuel.

### LOW

**L1 · hmac.mjs:15 — `parseInt` permissif**
Description : `parseInt("1750000000000abc")` → 1750000000000, accepté.
Impact réel : négligeable (la fenêtre ±5 min reste bornée) ; resserrer avec `/^\d+$/.test(timestampHeader)`.

**L2 · hmac.mjs:19-23 — format de signature supposé exact (hex lowercase)**
Description : comparaison case-sensitive après strip de `sha256=` ; l'émetteur doit produire exactement ce format.
Impact réel : risque d'interop silencieux si Mesgia envoie de l'uppercase ou un format différent — les tests génèrent le HMAC **avec le même code que le relais** (autocohérence, ne prouve pas l'interop). À valider contre un webhook réel de Mesgia (le relay.log ne montre que des rejets absents → probablement OK en prod, à confirmer).
Fix : test avec un vecteur produit indépendamment, ou acceptation case-insensitive (`provided.toLowerCase()`).

**L3 · env.mjs:11 — parser .env naïf : coupe à la PREMIÈRE `=`**
Description : `t.slice(eq+1)` tronque les valeurs contenant `=` (ex. secret base64 `abc==`).
Impact réel : un `MESGIA_WEBHOOK_SECRET` contenant `=` serait tronqué → HMAC mismatch permanent, webhooks rejetés sans explication.
Fix : ne couper qu'à la première `=` **ou** supporter les valeurs entre guillemets / base64url.

**L4 · relay.mjs:22 — `Number(BRAIN_TIMEOUT_MS ?? 120_000)` accepte `NaN`/`0`**
Description : une valeur vide (`BRAIN_TIMEOUT_MS=`) donne `Number("") = 0` → `setTimeout(..., 0)` → le cerveau est SIGKILLé immédiatement à chaque message.
Impact réel : daemon apparemment OK, toutes les réponses sont des fallbacks « cerveau n'a pas répondu ».
Fix : `const t = Number(...); Number.isFinite(t) && t > 0 ? t : 120_000`.

**L5 · server.mjs:32-33 — aucune limite de taille du body**
Description : `body += d` sans cap.
Impact réel : un webhook valide au body énorme charge la RAM ; nécessite une signature valide, donc atténué.
Fix : rejeter 413 si `body.length > 64_000` pendant l'accumulation.

**L6 · queue.mjs:5 — file sans limite ni backpressure ; fragile si `onError` jette**
Description : `chain = chain.then(handler).catch(onError)` ; si `onError` rejette (ex. log qui jette), la promesse rejetée reste dans `chain` → **tous les items suivants sont ignorés silencieusement**. Aussi : rafale Mesgia > débit cerveau (séquentiel, ~minutes) → backlog mémoire illimité.
Impact réel : improbable (console.error ne jette pas) mais panne totale silencieuse en cas de log défaillant ; lag croissant en rafale.
Fix : `chain = chain.then(handler).catch(err => { try { onError(err) } catch { console.error(err) } })` + cap optionnel (ex. 50 items).

**L7 · relay.mjs:6 — `process.env` écrase `.env`**
Description : `{ ...loadDotEnv(...), ...process.env }`.
Impact réel : un secret `MESGIA_*` exporté dans le shell (bashrc, service) prend le dessus silencieusement sur le `.env`.
Fix : ordre inversé ou warning si conflit.

**L8 · start.sh:18 — token cloudflared visible dans `ps aux`**
Description : `--token "$(cat ...)"` expose le token en clair dans la ligne de commande, lisible par tout user local du WSL (fichier 600 ✓, mais visible en ps).
Impact réel : faible en mono-user ; standard cloudflared.
Fix : config TOML tunnel (`~/.cloudflared/config.yml` + credentials file), le token n'apparaît plus en ligne de commande.

**L9 · start.sh:31-34 — `exit 1` laisse node + cloudflared tourner**
Description : si le health-check échoue après 30 s, le script sort en erreur **mais les deux background jobs continuent** (éventuellement fonctionnels après coup).
Impact réel : message d'échec trompeur, process détachés du script.
Fix : en cas d'échec, tuer les PID écrits (`kill` + `rm` pid files) avant `exit 1`.

**L10 · start.sh — pas de rotation de `relay.log`**
Description : une ligne par réponse, jamais tronqué.
Impact réel : croissance lente mais illimitée ; rien de critique.
Fix : `logrotate` ou compaction à l'arrêt.

**L11 · src/mesgia-client.mjs:7-28 — code mort**
Description : plus importé par le daemon (remplacé par `cbor-client.mjs`) ; seul `test/mesgia-client.test.mjs` l'utilise.
Impact réel : dette mineure, risque de confusion (deux clients de post).
Fix : supprimer avec son test, ou documenter « legacy ».

---

## Axes vérifiés sans finding

- **Clé privée wallet (MESGIA_WALLET_KEY) jamais journalisée** : aucun appel `console.log`/`log` n'inclut la clé ; `deriveAddress` est pure ; `.env` en `600` (vérifié) ; `relay.log` inspecté sans clé. ✅
- **HMAC** : `timingSafeEqual` utilisé avec garde de longueur (hmac.mjs:23) ; fenêtre ±5 min (hmac.mjs:16, testé) ; headers `X-Mesgia-Signature`/`X-Mesgia-Timestamp` absents → rejet 401 (hmac.mjs:12-14, testé) ; mauvais secret → 401 et cerveau jamais appelé (test d'intégration). ✅
- **Injection** : `spawn(bin, args)` sans `shell: true`, message = argument, tronqué à 4000 chars (brain.mjs:11, 36, 40). ✅
- **Ack immédiat sans champ `reply`** : server.mjs:55-56, `res.end` avant `enqueue`, testé (`assert.equal('reply' in ack, false)`). ✅
- **Fallback posté si le cerveau échoue** : server.mjs:16, testé (« cerveau en échec → message fallback posté »). ✅
- **Timeout cerveau** : présent (brain.mjs:42-44) — voir M1 pour le groupe de process. ✅ (avec réserve)
- **FIFO sans rejet silencieux** : `chain.then(handler).catch(onError)` loggue chaque erreur (queue.mjs:5, testé « une erreur n'interrompt pas la file »). ✅ (voir L6)
- **Réponse CBOR-Web** : signature EIP-191 couvrant `POST:/api/cbor-web/messages:{challenge}:{sha256(body)}` — anti-rejeu + anti-substitution, testé (wallet.mjs round-trip, cbor-client.test). ✅
- **start.sh** : `set -euo pipefail`, `.env` et token requis avec messages d'erreur clairs, **LF uniquement** (pas de piège CRLF/WSL), bind du serveur sur `127.0.0.1` (tunnel cloudflared en frontal). ✅
- **Variables d'env requises** : vérifiées au démarrage avec sortie explicite (relay.mjs:7-12). ✅
- **Tests** : 29/29 verts (`node --test test/*.test.mjs`). ✅
- **État réel** : daemon en production actuellement opérationnel — relay.pid 197045 et cloudflared.pid 197047 vivants, `relay.log` montre des réponses postées avec succès (`ok=true`). ✅

---

## Notes complémentaires

1. **`start.sh` non commité** : `git status` → `M start.sh` ; la version tunnel nommé token-based (dernier commit : `7e111b2 chore: ignore versions/...`) n'est **pas encore commitée**. Le diff working tree = le diff affiché plus haut.
2. **Prompt injection vers le cerveau** : le message utilisateur arrive non nettoyé dans le prompt ; la mitigation « N'utilise aucun outil » est une instruction LLM, pas un contrôle technique. Impact réel dépendant de la config de `kimi -p` (outils actifs ou non) — **à vérifier par le parent** : si le mode `-p` n'active pas d'outils/sandbox, considérer un flag de sandbox ou une config dédiée.
3. **Rejeu entrant** : le HMAC lie timestamp+body mais pas d'identifiant d'événement unique ; un rejeu dans la fenêtre ±5 min génère un doublon de réponse. Impact faible (non-retenu comme finding, mentionné pour information).
4. **Perte de message si crash du daemon entre ack et traitement** : la FIFO est en mémoire, non persistante — conséquence assumée de la contrainte « ack immédiat sans reply » ; couplé à M6, la résilience aux pannes est le point faible principal du design.
