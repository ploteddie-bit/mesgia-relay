# Revue production — Vague W4 (dette, monitoring & documentation P2) — 2026-08-18

## 1. Objet

- **Ce qui est livré / déployé** :
  - `P2-1` : `node_exporter` 1.9.1 en service systemd `--user` (bind `127.0.0.1:9100`) sur `ia-general` et `serveur-ia` ; watchdogs cron `/home/eddie/relay-watchdog.sh` (serveur-ia, `*/10 * * * *`) et `/home/eddie/gpu-watchdog.sh` (ia-general, `4-54/10 * * * *`). Alertes = fichiers `*-alertes.log`.
  - `P2-3` : commit `bcb6dd6` — `git rm src/mesgia-client.mjs`, `test/mesgia-client.test.mjs`, `versions/package.json.v0.bak.20260816-004635` (99 suppressions). `BRAIN_BIN` conservé (usage réel `relay.mjs:60` mode cli). `.bak.*` locaux **non** supprimés (Aegis bloque `rm`).
  - `P2-4` : commit `d495672` — +9 tests (`env`, `relay` exit codes via sous-processus, échecs IAQ non-JSON), `c8` en devDependency + script `npm run coverage`, couverture 85,73 % stmts / 81,63 % branch.
  - `P2-5` : route `.well-known` corrigée dans `/home/eddie/mesgia/AGENTS.md` (ligne 75 : à la racine, pas sous `/api`) ; note d'état réel ajoutée en tête de `/home/eddie/mesgia/docs/superpowers/plans/2026-08-16-mesgia-relay-prototype.md` (ligne 3). Indexation RAG du rapport final : hors revue (parent).

- **Critères d'acceptation (extraits du plan JSON)** :
  - `P2-1` : « métriques visibles ; alerte de test déclenchée ».
  - `P2-3` : « grep ne trouve plus mesgia-client.mjs importé ; moins de .bak.* ».
  - `P2-4` : « tous les tests verts ; couverture mesurée ».
  - `P2-5` : « docs cohérentes avec l'état réel ; rapport indexé ».

## 2. Constantes introduites/modifiées (P2)

| Constante | Valeur | Justification (mesure/source) |
|---|---|---|
| seuil file IAQ (`relay-watchdog.sh:20`) | `>= 5` | **Non justifiée par une mesure** (valeur arbitraire) — voir finding M3 |
| fenêtre de scrape watchdog | `*/10` (relais) / `4-54/10` (GPU) | espacement cron choisi, non mesuré (acceptable, non critique) |
| rotation log alertes | `5000` lignes | choix arbitraire, sans impact sécurité (fichier local) |

## 3. Tests d'échec exécutés (P3)

| Scénario d'échec | Comment testé | Résultat brut (preuve) |
|---|---|---|
| Variables `.env` manquantes | `test/relay.test.mjs` : `spawnSync relay.mjs` avec `MESGIA_API/WALLET_KEY/WEBHOOK_SECRET` vides | `exit 1` + `stderr` « Variables manquantes » (78/78 pass) |
| `BRAIN_MODE` invalide | `test/relay.test.mjs` : `BRAIN_MODE=invalide` | `exit 1` + `stderr` « BRAIN_MODE invalide » |
| Réponse IAQ non-JSON (submit/task/artifact) | `test/iaq-brain.test.mjs` : stubs `text/plain` | `{ok:false}` + erreurs « réponse submit/task/artifact IAQ non-JSON » (messages confirmés dans `src/iaq-brain.mjs:84-85,111-112,134-135`) |
| Fichier `.env` absent / lignes vides / sans `=` / guillemets | `test/env.test.mjs` | `loadDotEnv` → `{}` / clés-valeurs correctes / guillemets conservés |
| Alerte watchdog déclenchée | `relay-watchdog.sh --test` et `gpu-watchdog.sh --test` | lignes `ALERTE: test manuel watchdog` présentes dans `*-alertes.log` (23:22:45 et 23:31:13/23:34:23) |

## 4. Chemins d'échec — observabilité (P4)

- **Chemins silencieux trouvés : 2 (non bloquants sécurité, à corriger avant clôture P2-1)** — voir findings M1 et M2. Le défaut de fond : les deux watchdogs logguent `check ok` même quand leurs métriques sont `?` (sonde en échec), rendant la panne de la sonde elle-même invisible.

## 5. Revue indépendante (P5)

- **Réviseur** : subagent indépendant, 2026-08-18. Prompt : vérifier P2-1/P2-3/P2-4/P2-5 sur pièces (git, tests, couverture, docs, watchdogs via SSH, sécurité).
- **Points relevés** : 2 moyens (M1, M2), 4 mineurs (M3-M6), 1 note (N1). Détail ci-dessous.

### Findings par sévérité

**Moyen — M1 · chemin d'échec silencieux des sondes (`gpu-watchdog.sh:20`, `relay-watchdog.sh:24`)**
Les deux scripts terminent par `echo "... check ok (gpu=${gpu:-?}% queue_iaq=${q:-?})"`. Quand `rocm-smi` ou `curl /api/monitoring` échoue, les variables sont vides → la ligne affiche `?` mais dit quand même « check ok », **sans alerte**. Preuve réelle : `gpu-watchdog.log` 23:31:13 `check ok (gpu=?% queue_iaq=?)`. Conséquence : si la sonde GPU ou IAQ tombe en panne (ou change de format), la surveillance devient aveugle. Contredit la charte « aucun chemin d'échec silencieux ».

**Moyen — M2 · dépendance non gérée au patch P0-2 (`relay-watchdog.sh:19`, `gpu-watchdog.sh:16`)**
Les deux watchdogs appellent `http://10.0.0.223:8001/api/monitoring` **sans token**. Le patch P0-2 (toujours en attente Eddie) ajoute un Bearer obligatoire sur `/api/monitoring`, y compris sur le LAN (`10.0.0.223:8001`). Après déploiement, ces curls renverront `401` → `q` vaudra `0` (JSON sans clé `queue`) ou vide → la surveillance de la file IAQ se désactive **silencieusement** (faux négatif). À traiter en même temps que P0-2 : fournir un token au watchdog, ou sonder un endpoint resté public (ex. `/version`).

**Mineur — M3 · seuil `>=5` non justifié (`relay-watchdog.sh:20`)**
Le seuil de file IAQ `>=5` n'est documenté par aucune mesure (charte P2 « constantes justifiées par mesure »). Il est en outre **supérieur** à la valeur observée de la panne du jour (queue=4, ledger W3) → risque de faux négatif à 4.

**Mineur — M4 · fragilité du parse GPU (`gpu-watchdog.sh:15`)**
`rocm-smi --showuse | grep -oE 'GPU use \(%\): [0-9]+'` dépend du format exact de la sortie. Une évolution de `rocm-smi` casse la sonde (gpu vide) et aggrave M1. Fonctionnel aujourd'hui (preuve `gpu=2%`).

**Mineur — M5 · critère P2-3 « moins de .bak.* » partiellement atteint**
`grep mesgia-client` est vide dans `src/` et `relay.mjs` (✓), mais il reste **40 `.bak.*`** (28 dans `src/`, 12 dans `test/`), non versionnés (`git ls-files` = 0, ignorés par `*.bak.*` dans `.gitignore`), non supprimés car Aegis bloque `rm`. Correctement documenté dans le ledger, mais reste à faire pour Eddie.

**Mineur — M6 · `loadDotEnv` ne strip pas les guillemets (`src/env.mjs:11`)**
Comportement verrouillé par `test/env.test.mjs` (« guillemets conservés tels quels »). Sans impact aujourd'hui (le `.env` réel n'utilise pas de guillemets), mais fragile si un futur `.env` contient des valeurs quotées avec espaces/`#`.

**Note — N1 · bruit `node_exporter`**
Erreurs `broken pipe` dans les journaux (client scrape déconnecté) — bénin, sans impact sécurité.

### Vérifications positives (non-findings)

- `git log --oneline` : `d495672`, `bcb6dd6` présents en HEAD (`master`), working tree propre (3 fichiers `reviews/` non suivis uniquement).
- `git show bcb6dd6` : 3 suppressions strictes, aucun secret, périmètre respecté.
- `git show d495672` : +9 tests + `c8` + `coverage/` dans `.gitignore`, aucun secret, périmètre respecté.
- `npm test` : **78/78 pass, 0 fail**.
- `npm run coverage` : **85,73 % stmts / 81,63 % branch / 80,43 % funcs** ; `env.mjs` 100 %.
- `grep -rn mesgia-client src/ relay.mjs` : vide (reste uniquement dans `reviews/` historiques).
- `BRAIN_BIN` référencé `relay.mjs:60`, `README.md:23`, `.env.example:10` ; `MESGIA_AGENT*` absent.
- `curl https://mesgia.explodev.workers.dev/.well-known/cbor-web` → **HTTP 200** ; `/api/.well-known/cbor-web` → **HTTP 404** (correction AGENTS.md:75 exacte).
- `node_exporter` : `ss -tln` montre `127.0.0.1:9100` sur les deux hôtes ; service `--user` `active` ; `--web.listen-address=127.0.0.1:9100` (non exposé).
- Sécurité : les watchdogs n'utilisent aucun token et ne logguent que timestamps/compteurs/statuts ; **aucun secret** dans les scripts, les commits ni les logs.

## 6. Verdict

- [x] **GO — déployable** (conditionnel sur M1 + M2 à corriger avant de clore P2-1)
- [ ] NO-GO — raisons :

Le périmètre code (`P2-3`, `P2-4`) et documentation (`P2-5`) est sain et vérifié sur pièces. `P2-1` est fonctionnel (node_exporter en loopback, alertes de test réellement déclenchées) mais comporte deux chemins d'échec silencieux (M1, M2) dans des scripts ops **non versionnés** qui doivent être corrigés avant de considérer `P2-1` terminé. Aucun secret, aucun blocage sécurité sur les données.

- Réviseur humain (si requis) : Eddie.

## 7. Preuves finales

- Sortie des tests : `ℹ tests 78 · pass 78 · fail 0 · duration_ms ~2953` (idem sous `c8`).
- Sortie du build : N/A (Node stdlib, pas d'étape build).
- Vérif post-déploiement : node_exporter `active` + `127.0.0.1:9100` (x2) ; `*-alertes.log` contiennent les alertes de test ; `.well-known/cbor-web` 200 vs 404.
