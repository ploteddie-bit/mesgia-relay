# Revue production — Vague W3 fiabilité Mesgia-relay — 2026-08-18

> Gabarit charte P5/P6. Réviseur : subagent indépendant (code review + exécution des tests).
> Commit revu : `d2103ba435eb1120eead7c31806cf268505a61da` (HEAD de `/home/eddie/mesgia-relay`, poussé sur `origin` GitHub et déployé sur serveur-ia).

## 1. Objet
- **Ce qui est déployé** : commit `d2103ba` « fix(fiabilite): anti-rejeu HMAC double cle, prompt system/user, retry+dead-letter, kill groupe, stderr, timeouts fetch ».
  - Fichiers : `.gitignore`, `relay.mjs`, `src/brain.mjs`, `src/cbor-client.mjs`, `src/iaq-brain.mjs`, `src/replay-guard.mjs` (nouveau), `src/server.mjs`, et 8 fichiers de test + 3 fixtures.
  - 17 fichiers, 770 insertions / 30 suppressions.
- **Critères d'acceptation (P1)** — vérifiés un à un :
  - **P1-1** anti-rejeu HMAC : « un webhook rejoué est rejeté » → implémenté (double clé signature+timestamp **et** nonce optionnel, persistance `data/seen-nonces.json`). Rejet effectif en `409` (voir mineur M-1 : le plan écrit littéralement « 401 »).
  - **P1-2** prompt structuré system+user : « injection simple neutralisée » → implémenté dans `src/iaq-brain.mjs` (rôles `system`/`user` séparés) et `src/brain.mjs` (marqueur anti-injection pour le mode CLI).
  - **P1-7** findings M1/M2/M3/M6 : kill du groupe de process (M1), lecture+bornage stderr (M2), AbortSignal/timeout sur les fetch CBOR-Web (M3), retry borné 1× + dead-letter 0600 (M6) → implémentés.

## 2. Constantes introduites/modifiées (P2)
| Constante | Valeur | Justification (mesure/source) |
|---|---|---|
| `DEFAULT_REPLAY_TTL_MS` | 10 min | Couvre la fenêtre HMAC ±5 min (`TOLERANCE_MS` dans `src/hmac.mjs`) avec marge |
| `DEFAULT_RETRY_DELAY_MS` | 2 000 ms | Backoff unique avant le retry postReply (valeur de départ raisonnable, à mesurer en prod) |
| `MAX_STDERR_CHARS` / `STDERR_EXCERPT_CHARS` | 4 000 / 500 | Bornage mémoire du buffer stderr + lisibilité de l'extrait remonté |
| `FETCH_TIMEOUT_MS` | 10 000 ms | Au-delà du temps de réponse CBOR-Web attendu (challenge + POST) |
| `SYSTEM_PROMPT` | (texte) | Consignes relais minimales, utilisées comme rôle système en mode iaq |

## 3. Tests d'échec exécutés (P3)
| Scénario d'échec | Comment testé | Résultat brut (preuve) |
|---|---|---|
| Rejeu webhook (P1-1) | `test/server-replay.test.mjs` : rejeu identique, nonce rejoué, nonce modifié | 3 tests verts ; rejeu → HTTP 409 |
| Dépendance down / timeout cerveau | `test/iaq-brain.test.mjs` (401 submit, tâche `failed`, artifact 404, timeout global) + `test/brain-kill-stderr.test.mjs` (timeout spawn) | verts ; fallback générique sans fuite |
| Ressource saturée / spawn enfant (M1) | `test/brain-kill-stderr.test.mjs` : grandchild tué avec le groupe | vert ; `process.kill(childPid,0)` → ESRCH |
| Entrée invalide | `test/hmac.test.mjs` (signature/timestamp/mauvais secret) ; `server-replay` (même ts + corps différent accepté) | verts |
| stderr long (M2) | `test/brain-kill-stderr.test.mjs` : buffer borné, fin du flux conservée | vert ; extrait ≤ 500 chars |
| Timeout fetch CBOR-Web (M3) | `test/cbor-timeout.test.mjs` : signal présent + timeout challenge/POST | verts |
| Retry / dead-letter (M6) | `test/server-retry.test.mjs` : retry 1× sur 5xx, dead-letter sur échec final, pas de retry sur 4xx | verts |
| Fuite de token | `test/iaq-brain.test.mjs` « token jamais présent dans les logs » | vert |
| **Total** | `npm test` dans `/home/eddie/mesgia-relay` | **64/64 pass, 0 fail** (durée 2,9 s) |

Vérifications manuelles complémentaires (preuves brutes) :
- `dead-letter` : fichier créé en mode **600** ; nom assaini (`conv/x?test` → `conv_x_test`) ; clés `ts/conversationId/reply/error` uniquement (aucun secret, pas le message utilisateur d'origine).
- Persistance anti-rejeu : fichier `seen.json` écrit en mode **644** (→ mineur M-2) ; écriture atomique confirmée (aucun `.tmp` résiduel).
- Diff `d2103ba` : aucune valeur de secret (grep sur `0x[0-9a-f]{32,}`, `PRIVATE KEY`, `Bearer …`, `api_key`, `token=`, `secret=`) — uniquement des noms de variables et des constantes de test inoffensives.

## 4. Chemins d'échec — observabilité (P4)
- **Refus/blocages/retries/fallbacks du diff et leur log associé :**
  - Signature/timestamp/nonce rejoué → `log('push rejeté: …')` puis HTTP 409/401.
  - `postReply` échoue → `log('premier échec … — retry …')`, retry 1×, puis `log('ÉCHEC post réponse …')` et `log('dead-letter écrit …')`.
  - Dead-letter impossible → `log('dead-letter échec …')` (pas d'échec silencieux).
  - Erreur FIFO → `log('erreur fifo: …')`.
  - Erreur persistance anti-rejeu → `log('anti-rejeu persistance: …')` (config prod `relay.mjs:68`).
  - Cerveau timeout/échec → message fallback « ⚠️ Le cerveau n'a pas répondu … » posté sur Mesgia (aucun silence).
- **Chemins silencieux trouvés :** aucun en configuration production. Le défaut `onError = () => {}` de `createReplayGuard` est silencieux **mais** il est surchargé par un `log` explicite dans `relay.mjs` (production). Le `catch { /* déjà terminé */ }` du kill de groupe est intentionnel et bénin.

## 5. Revue indépendante (P5)
- **Réviseur :** subagent indépendant (relecture complète du code + `npm test` + inspection du diff), 2026-08-18.
- **Points relevés :** aucun bloquant, aucun majeur ; 7 mineurs différés (voir ci-dessous).
- **Corrections appliquées :** aucune dans le code à ce stade (les mineurs sont différés, à trancher avec Eddie).

### Findings (mineurs — différés mais à traiter)
- **M-1 — écart contrat 401 vs 409.** `src/server.mjs:114` retourne `409` pour le rejeu, alors que le critère P1-1 du plan (`plan-deploiement-mesgia-relais-20260818.json`, critère « un webhook rejoué est rejeté 401 ») spécifie `401` ; `test/server-replay.test.mjs:43` codifie `409`. Correction : trancher — recommandé de mettre à jour le critère du plan en `409` (sémantiquement plus juste pour un rejeu), sinon aligner le code sur `401`. Non bloquant : `4xx` non retenté côté client dans les deux cas.
- **M-2 — permissions du fichier de persistance anti-rejeu.** `src/replay-guard.mjs:58` écrit `data/seen-nonces.json` sans `mode` → fichier en `644` (vérifié). Le contenu (signatures HMAC + nonces) n'est pas un secret au sens strict (déjà présent dans les en-têtes réseau), mais par hygiène : passer `{ mode: 0o600 }` à `writeFileSync`.
- **M-3 — permissions des répertoires.** `src/server.mjs:39` (`dead-letters/`) et `src/replay-guard.mjs:57` (`data/`) créent les dossiers en `755` (umask). `dead-letters/` contient des réponses conversationnelles (fichiers `600`, mais noms listables). Recommandé : `0700` sur `dead-letters/` (et `data/` par cohérence).
- **M-4 — fetch non borné sur `register`.** `src/cbor-client.mjs:74` : le POST `/api/cbor-web/register` n'a pas de `signal: AbortSignal.timeout(...)`, contrairement à l'énoncé M3 « AbortSignal sur les fetch CBOR-Web ». `fetchChallenge` (l.29) et le POST de `postReply` (l.122) en ont. `register` est hors chemin critique de prod (script de setup), mais le fetch peut rester bloqué indéfiniment. Correction : ajouter le signal.
- **M-5 — commentaire de fixture inversé.** `test/fixtures/fail-stderr-long.mjs:2-3` affirme « seul le début doit être conservé, le marqueur de fin doit être ignoré », ce qui est l'inverse du comportement réel (le code conserve la **fin** du flux, `src/brain.mjs:61` ; le test `test/brain-kill-stderr.test.mjs:24-26` vérifie bien la fin). Correction : aligner le commentaire.
- **M-6 — fuite de diagnostic en mode CLI.** En mode `cli` (défaut `relay.mjs:17`), l'extrait stderr (≤ 500 chars, `src/brain.mjs:82`) remonte dans `result.error`, qui devient le message fallback posté sur Mesgia (`src/server.mjs:56` + `FALLBACK_REPLY`). Du diagnostic interne de `kimi` peut donc fuiter vers l'utilisateur final. Pas de secret concerné ; en prod `BRAIN_MODE=iaq` l'erreur reste générique. Correction : logger le stderr (via `log`) et garder le fallback générique.
- **M-7 — borne absente sur le chemin rétrocompat.** `src/iaq-brain.mjs:155` : le chemin `prompt` seul (rétrocompat) n'applique pas `MAX_INPUT_CHARS` (seul `userMessage` la subit, l.153). Chemin mort en prod (`relay.mjs` utilise toujours `systemPrompt`+`userMessage`), mais incohérent. Correction : appliquer aussi `.slice(0, MAX_INPUT_CHARS)` à `prompt`.

## 6. Verdict
- [x] **GO — déployable**
- [ ] NO-GO — raisons : —
- Réviseur humain (si requis) : Eddie, à valider — notamment la décision M-1 (401 vs 409).

## 7. Preuves finales
- **Sortie des tests :** `npm test` → `tests 64, pass 64, fail 0, cancelled 0, skipped 0` (durée 2 865 ms).
- **Sortie du build :** N/A — pas d'étape de build (modules ESM purs, `npm test` lance `node --test`).
- **Vérif post-déploiement :** le ledger `progress.md` (section « W3 — Diagnostic E2E ») documente, le 2026-08-18 ~20:42Z, un timeout du cerveau IAQ (cause infra : contention VRAM, pas un bug du relais) et un message d'erreur gracieux posté sans dead-letter — comportement conforme au design M6. À confirmer par le réviseur humain en prod (non re-vérifié directement depuis ce poste).
