# Revue production — mode « ollama » (cerveau local) — 2026-08-18

> Gabarit obligatoire (charte P5/P6). Revue INDÉPENDANTE — aucun code modifié pendant la revue.

## 1. Objet
- Ce qui est déployé : nouveau `BRAIN_MODE=ollama` dans `relay.mjs`, nouveau module `src/ollama-brain.mjs`, nouveaux tests `test/ollama-brain.test.mjs`. Non commité.
- Diff réel vérifié (`git status` / `git diff`) :
  - `relay.mjs` : modifié (15 insertions, 3 suppressions) — import `invokeBrainOllama`, ajout de `'ollama'` à la liste des modes acceptés, câblage `OLLAMA_URL` / `OLLAMA_MODEL` / `OLLAMA_KEEP_ALIVE` / timeout défaut 60 s.
  - `src/ollama-brain.mjs` : nouveau (88 lignes), non suivi.
  - `test/ollama-brain.test.mjs` : nouveau (174 lignes, 9 tests), non suivi.
  - Fichiers non suivis hors périmètre (revues antérieures, non liés à ce diff) : `reviews/2026-08-18-revue-patch-auth-dashboard-iaq.md`, `reviews/2026-08-18-revue-w3-fiabilite.md`.
- Critères d'acceptation (P1) :
  - Succès : POST `/api/chat` Ollama local → réponse bornée et renvoyée ; 73/73 tests verts.
  - Échecs : injection confinée au rôle user ; HTTP ≠ 200 → erreur générique ; non-JSON ; réponse vide ; timeout (AbortError) ; entrée/sortie bornées ; rétrocompat `prompt` seul.

## 2. Constantes introduites/modifiées (P2)
| Constante | Valeur | Justification (mesure/source) |
|---|---|---|
| `OLLAMA_DEFAULT_TIMEOUT_MS` | `60_000` | CPU local 7B-q4 ≈ 8–12 tok/s (doc module) ; réponse réelle mesurée 4,3 s |
| `OLLAMA_DEFAULT_NUM_PREDICT` | `512` | Borne haute de génération (réponse de messagerie, pas un essai) |
| Défaut `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama local à l'hôte du relais, sans file IAQ |
| Défaut `OLLAMA_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | Modèle local mesuré à 9,5 tok/s (contexte) |
| Défaut `OLLAMA_KEEP_ALIVE` | `'4h'` | Garde le modèle chargé en mémoire entre les messages |
| `MAX_INPUT_CHARS` | `4000` (réutilisé de `brain.mjs`) | bornage entrée utilisateur |
| `MAX_REPLY_CHARS` | `5000` (réutilisé de `iaq-brain.mjs`) | limite dure Mesgia |

## 3. Tests d'échec exécutés (P3)
| Scénario d'échec | Comment testé | Résultat brut (preuve) |
|---|---|---|
| Dépendance down (HTTP 500) | `test/ollama-brain.test.mjs:93` | `ok:false`, erreur générique `Ollama chat HTTP 500`, détail au log seulement — PASS |
| Timeout | `test/ollama-brain.test.mjs:134` (stub hangMs 500, timeoutMs 100) | `ok:false`, erreur `timeout cerveau` — PASS |
| Ressource saturée | équivalent timeout ci-dessus (pas de file IAQ en mode ollama) | couvert par le test timeout |
| Entrée invalide (non-JSON, vide) | `test/ollama-brain.test.mjs:110` et `:122` | `ok:false` sur non-JSON et contenu vide — PASS |
| Injection | `test/ollama-brain.test.mjs:74` | rôles system/user séparés, texte brut non re-rôlé — PASS |
| Bornes | `test/ollama-brain.test.mjs:147` et `:159` | réponse bornée à `MAX_REPLY_CHARS` ; `prompt` seul borné — PASS |

Suite complète : `npm test` → **73/73 pass, 0 fail** (durée 3 083 ms).

## 4. Chemins d'échec — observabilité (P4)
- Refus/blocages/retries/fallbacks du diff et leur log :
  - HTTP ≠ 200 → `log('Ollama chat HTTP <status>: <200 chars corps réponse>')`, retour générique (pas de détail vers le fallback) — `src/ollama-brain.mjs:67-69`.
  - Non-JSON → `log('réponse Ollama non-JSON')` — `src/ollama-brain.mjs:72-74`.
  - Fetch/AbortError → timeout renvoyé générique, autres erreurs `log('ollama-brain fetch échoué: <message>')` — `src/ollama-brain.mjs:81-84`.
  - Le fallback (message posté sur Mesgia) n'expose que le `error` générique : `src/server.mjs:9` et `:56`.
- Chemins silencieux trouvés : **aucun bloquant.** Le seul cas « silencieux » est la réponse vide sans log (`src/ollama-brain.mjs:77-79`) — acceptable, c'est un état métier normal, pas une panne masquée.

## 5. Revue indépendante (P5)
- Réviseur : subagent indépendant, 2026-08-18. Prompt : vérifier le diff non commité du mode ollama (fichiers, tests, cohérence `relay.mjs`, angles morts, secrets), exécuter `npm test`, vérifier chaque point demandé.
- Points relevés (aucun bloquant) :
  - **M1 — marge timeout serrée** : `src/ollama-brain.mjs:24-25`. `OLLAMA_DEFAULT_NUM_PREDICT = 512` à 8–12 tok/s ≈ 43–64 s, soit au bord du `timeoutMs` défaut 60 000 ms. Une génération qui atteint réellement 512 tokens risque un timeout juste avant la fin → réponse perdue + fallback. En pratique les réponses mesurées sont courtes (~4,3 s), mais la marge n'est pas confortable. Correction suggérée : `num_predict` à 256, ou timeout défaut à 90 000 ms, ou documenter explicitement que 512 est une borne rarement atteinte.
  - **M2 — test d'injection structurel, pas comportemental** : `test/ollama-brain.test.mjs:74-91`. Le test prouve que le JSON envoyé sépare `system`/`user` et ne re-rôle pas le contenu ; il ne prouve pas (et ne peut pas prouver unitairement) que le modèle obéit au confinement. C'est honnête et correct comme garde-fou côté code — à mentionner comme limite, pas un défaut.
  - **M3 — robustesse du stub timeout (nitpick)** : `test/ollama-brain.test.mjs:16-44`. Le stub n'installe pas de handler `res.on('error')` ; après l'abort du client, l'écriture différée (`hangMs=500`) peut émettre une erreur non gérée sur le socket. Le test passe aujourd'hui (l'abort ferme le socket avant), mais ajouter `res.on('error', () => {})` éviterait une flakiness potentielle.
  - **O1 — divergence de rétrocompat `prompt`** : `src/ollama-brain.mjs:49` borne le chemin rétrocompat (`String(prompt ?? '').slice(0, MAX_INPUT_CHARS)`), alors que `src/iaq-brain.mjs:155` ne le borne pas (`{ role: 'user', content: prompt }`). ollama-brain est en réalité plus strict que le commentaire « identique à iaq-brain » ne le laisse entendre. Hors périmètre du diff (iaq-brain), mais à harmoniser éventuellement.
- Corrections appliquées : aucune (revue seule — ne pas modifier le code revu).

Vérifications demandées, point par point :
1. Diff conforme : oui, exactement import + mode `'ollama'` + câblage (3 edits), rien de superflu.
2. `npm test` : 73/73 verts.
3. `ollama-brain.mjs` : pas de fuite du corps utilisateur dans les logs (seul le corps de *réponse* HTTP et `err.message` sont loggés, jamais le corps de requête) ; `clearTimeout(timer)` bien dans `finally` (`:86`) ; chemin `prompt` seul borné (`:49`) ; `MAX_INPUT_CHARS` exporté par `brain.mjs:5` et `MAX_REPLY_CHARS` par `iaq-brain.mjs:23` ; slashes finaux multiples gérés par `apiUrl.replace(/\/+$/, '')` (`:54`).
4. `relay.mjs` : `required` initial (`:10`) inchangé et correct — le mode ollama n'ajoute aucune variable secrète (Ollama local sans auth). Timeout défaut 60 s (`:55`) cohérent : `server.mjs` fait un ack HTTP immédiat puis traite le cerveau en FIFO arrière-plan (`server.mjs:127-130`), donc aucun timeout HTTP concurrent ne vient s'ajouter.
5. Tests : l'injection prouve le confinement structurel (limite honnête, cf. M2) ; le timeout prouve bien le chemin `AbortError → 'timeout cerveau'` (`test:134-145` + `ollama-brain.mjs:82`).
6. Secrets : aucun secret dans le diff (scan `grep` sur les 3 fichiers — seules des mentions de test/commentaires et des références existantes hors périmètre ollama).

## 6. Verdict
- [x] **GO — déployable** (sous réserve de suivre M1 en doc/config, non bloquant)
- [ ] NO-GO — raisons :
- Réviseur humain (si requis) : Eddie, 2026-08-18

## 7. Preuves finales
- Sortie des tests : `npm test` → `tests 73 / pass 73 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 3082.72`
- Sortie du build : N/A (module ESM sans étape de build ; import résolu par `node --test`)
- Vérif post-déploiement (à remplir après) : — (mesure réelle du mode ollama en conditions de prod : latence, temps de réponse, charge CPU de serveur-ia)
