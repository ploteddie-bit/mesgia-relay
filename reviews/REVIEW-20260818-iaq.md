# Review indépendante — Phase 1.5 : cerveau IAQ Router (iaq-brain)

- **Date** : 2026-08-18
- **Reviewer** : subagent indépendant (pas de vision de la conversation parente)
- **Fichiers revus** :
  - `src/iaq-brain.mjs` (nouveau — client HTTP IAQ Router)
  - `relay.mjs` (modifié — sélection `BRAIN_MODE` cli/iaq)
  - `.env.example` (modifié — doc des variables iaq)
  - `test/iaq-brain.test.mjs` (nouveau — 9 tests stub HTTP)
  - Modules connexes relus : `src/server.mjs`, `src/brain.mjs`, `test/brain.test.mjs`, `package.json`
- **Vérifications exécutées** :
  - `npm test` (node v24.18.0) → **38/38 tests verts**, dont les 9 nouveaux tests iaq
  - `git status` / `git diff` : seuls `.env.example` et `relay.mjs` modifiés ; `package.json`/`package-lock.json` intacts (aucune dépendance ajoutée) ; `src/iaq-brain.mjs` et `test/iaq-brain.test.mjs` nouveaux
  - État réel : daemon `node relay.mjs` (PID 197045) démarré ~52 min avant le changement → **tourne encore l'ancien code ; le mode iaq n'est pas déployé en réel**
  - `relay.log` relu : aucun token ni header Authorization journalisé historiquement

## Verdict global : **GO avec réserves**

La mécanique cœur est correcte, complète et testée : chaque fetch est borné par une deadline globale via AbortSignal, la boucle de poll ne peut pas dépasser la deadline, `completed`/`failed` sont traités dans le bon ordre, le sleep est borné par `Math.min`, le token n'apparaît dans aucun message d'erreur ni dans l'URL (header uniquement), `BRAIN_MODE` invalide et `IAQ_TOKEN` absent sont rejetés proprement, `parseTimeoutMs` corrige bien le bug `Number("")=0`, et aucune dépendance npm n'a été ajoutée.

Les réserves sont de sévérité **faible à moyenne**, aucune bloquante : (1) le câblage `relay.mjs` ne branche pas la fonction `log` vers `invokeBrainIAQ` → les erreurs IAQ détaillées ne sont **jamais journalisées en prod** ; (2) la borne 5000 ne s'applique qu'au rendu final, pas à la lecture réseau des corps ; (3) un `completed` détecté à quelques ms de la deadline fait échouer la récupération de l'artifact ; (4) le prompt système est concaténé dans le message `user` (aucun rôle `system` séparé) ; (5) `BRAIN_TIMEOUT_MS` partagé entre les modes rend le défaut 180 s documenté inatteignable avec le `.env.example` fourni.

---

## Findings

### HIGH

Aucun finding haute sévérité. Les axes de sécurité critiques demandés (token jamais loggé, header Authorization jamais loggé, aucune fuite du token via URL/messages d'erreur) sont conformes et vérifiés (voir « Axes vérifiés sans finding »).

### MEDIUM

**M1 · relay.mjs:34-40 — le câblage ne branche pas `log` vers `invokeBrainIAQ` : erreurs IAQ jamais journalisées en prod**
Description : `brain = async (message) => invokeBrainIAQ({ prompt, apiUrl, token, model, timeoutMs })` ne passe pas `log`. Dans `iaq-brain.mjs:111`, le défaut `log = () => {}` (noop) s'applique donc : en production, `log(\`iaq-brain: ${message}\`)` (ligne 139) n'écrit rien.
Impact réel : en mode iaq, `relay.log` ne contiendra que `réponse postée conv=... ok=false` (server.mjs:19) sans le détail de la panne (401, timeout, tâche failed, artifact 404…). Le détail ne subsiste que dans le message de fallback posté sur Mesgia. Diagnostic aveugle des pannes IAQ — même défaut d'observabilité que M2 de la review précédente côté cli, reproduit ici. Le test « token jamais présent dans les logs » (iaq-brain.test.mjs:153-166) valide le module isolé avec un `log` injecté, mais **pas le câblage réel** : il donne l'impression que l'erreur est journalisée en prod, ce qui n'est pas le cas.
Fix chirurgical : `brain = async (message) => invokeBrainIAQ({ prompt: buildPrompt(message), apiUrl: ..., token: ..., model: ..., timeoutMs: ..., log: (msg) => console.error(\`${new Date().toISOString()} ${msg}\`) })` — la même fonction de log que celle passée à `createRelayServer` (relay.mjs:61).

### LOW

**L1 · iaq-brain.mjs:60, 85, 102 — la borne 5000 ne s'applique qu'au rendu final, pas à la lecture réseau**
Description : `res.text()` (submit) et `res.json()` (poll, artifact) lisent le corps **complet** en mémoire ; le `reply.slice(0, MAX_REPLY_CHARS)` (ligne 135) tronque après coup. Aucune vérification de `Content-Length` ni lecture bornée.
Impact réel : un artifact anormalement gros (ou un routeur dévoyé) est parsé intégralement avant troncature → mémoire du daemon proportionnelle à la réponse. Faible en pratique (routeur interne de confiance), mais la consigne « réponse bornée 5000 » n'est satisfaite qu'en sortie, pas en entrée.
Fix chirurgical : avant `res.json()`, rejeter si `Number(res.headers.get('content-length') ?? 0) > MAX_REPLY_CHARS * 8` (ou un plafond dédié), ou lire en streaming avec un compteur d'octets.

**L2 · iaq-brain.mjs:117-130 — `completed` détecté à quelques ms de la deadline → récupération de l'artifact abortée, réponse perdue**
Description : si le dernier poll renvoie `status: 'completed'` avec très peu de temps restant avant `deadline`, la boucle sort (break, ligne 120) puis `fetchArtifact` (ligne 130) repart avec `remainingTimeout` ≈ 0 : le AbortController aborte le fetch presque immédiatement → `ok:false 'timeout cerveau'` alors que la réponse était disponible.
Impact réel : perte d'une réponse valide dans une fenêtre étroite (l'overhead JS entre le poll et le fetch de l'artifact suffit). Rareté faible, conséquence = message de fallback posté, pas de crash.
Fix chirurgical : après `break` sur `completed`, si `remainingTimeout(deadline) < 2000` (budget minimal), réserver un budget dédié pour l'artifact : `const artifactDeadline = Math.max(deadline, Date.now() + 5000)` — ou, plus simple, refaire un `fetchArtifact` avec un délai borné indépendant uniquement dans ce cas.

**L3 · iaq-brain.mjs:47 + brain.mjs:8-11 — prompt système concaténé dans le message `user`, aucune séparation de rôle : défense faible contre l'injection**
Description : `buildPrompt(message)` (brain.mjs:10-12) concatène le préfixe système **dans** le message utilisateur ; en mode iaq, ce bloc part tel quel dans `payload.messages: [{role:'user', content: prompt}]` (iaq-brain.mjs:47). Le modèle ne peut donc pas distinguer les instructions du relais du contenu arbitraire de l'utilisateur (« ignore ce qui précède… »).
Impact réel : un correspondant Mesgia peut tenter de rediriger le cerveau hors cadre. Mitigé par le canal (pas d'outils/exfiltration via ce cerveau) et la troncature à 4000 chars ; risque limité à une réponse hors cadre. Le contrat IAQ vérifié n'a testé qu'un seul message `user` — l'ajout d'un message `system` séparé est plausible mais à re-vérifier côté routeur.
Fix chirurgical : si le routeur accepte plusieurs messages, envoyer `payload.messages: [{role:'system', content: PROMPT_PREFIX}, {role:'user', content: String(message).slice(0, MAX_INPUT_CHARS)}]` et ne plus passer par `buildPrompt` en mode iaq ; sinon documenter explicitement la limite de la mitigation actuelle.

**L4 · relay.mjs:39 + .env.example:10 — `BRAIN_TIMEOUT_MS` partagé entre modes : le défaut 180 s documenté est inatteignable avec le `.env.example` fourni**
Description : le `.env.example` fixe `BRAIN_TIMEOUT_MS=120000`, variable unique pour les deux modes. En mode iaq, `parseTimeoutMs(env.BRAIN_TIMEOUT_MS, 180_000)` rendra donc **120 s** en pratique (latence réelle ~90 s → marge 30 s seulement), et la constante `IAQ_DEFAULT_TIMEOUT_MS = 180_000` (iaq-brain.mjs:16) ainsi que le test « défaut >= 120 s » ne s'appliquent que si la variable est absente/invalide.
Impact réel : marge de timeout plus fine que documentée en mode iaq ; l'énoncé du changement (« timeout défaut 180 s en iaq ») ne correspond pas au comportement réel avec la config d'exemple. Non bloquant (120 s reste > 90 s observés).
Fix chirurgical : variable dédiée `IAQ_TIMEOUT_MS` en mode iaq (avec `parseTimeoutMs(env.IAQ_TIMEOUT_MS, 180_000)`), et `BRAIN_TIMEOUT_MS` réservé au mode cli ; ou commentaire dans `.env.example` précisant qu'en mode iaq il faut passer la valeur à 180000.

**L5 · server.mjs:5-6 + iaq-brain.mjs:62 — le corps d'erreur HTTP IAQ (200 chars) est posté tel quel dans le fallback sur Mesgia**
Description : `FALLBACK_REPLY` inclut `error` ; pour submit, `error` contient `IAQ submit HTTP ${status}: ${text.slice(0, 200)}` (iaq-brain.mjs:62), donc jusqu'à 200 chars du corps de réponse du routeur finissent dans un message visible dans une conversation Mesgia.
Impact réel : fuite d'informations internes du routeur (messages d'erreur techniques) vers des conversations. Ne peut pas contenir le token (le token est émis, jamais reçu), mais peut exposer des détails d'implémentation. Comportement hérité du fallback existant (`exit code N` en cli), simplement étendu au corps HTTP.
Fix chirurgical : en mode iaq, tronquer le corps à une forme générique (ex: ne garder que le statut HTTP) ou marquer les erreurs IAQ comme « à ne pas exposer » dans le fallback.

**L6 · iaq-brain.mjs:41, 114 — paramètre `log` passé à `submit` mais jamais utilisé (mort)**
Description : `submit({ prompt, apiUrl, token, model, deadline, log })` reçoit `log` (ligne 41) et l'appel le transmet (ligne 114), mais le corps de `submit` ne l'utilise jamais.
Impact réel : aucun (code mort), propreté. À retirer ou à utiliser (log du taskId reçu, sans le token, serait utile pour corréler relay.log ↔ routeur IAQ).
Fix chirurgical : retirer `log` de la signature de `submit`, ou l'utiliser pour journaliser `submit ok task=${taskId}`.

**L7 · iaq-brain.mjs:85-86 — `res.json()` de `pollTask` hors du try/catch local : JSON invalide → message d'erreur anglais brut**
Description : le `await res.json()` (ligne 85) est en dehors du `try`/`catch` de `pollTask` ; en cas de réponse non-JSON (200 avec corps vide ou texte), le `SyntaxError` d'undici remonte au catch global de `invokeBrainIAQ` → `{ok:false, error: 'Unexpected token ...'}` (message anglais, opaque) puis part dans le fallback.
Impact réel : fonctionnellement géré (pas de crash, `ok:false`), mais message d'erreur peu propre et non localisé — même constat pour `res.text()` de `submit` (ligne 60). Le point d'attention « JSON invalide » est donc couvert, sans élégance.
Fix chirurgical : envelopper les lectures dans les try/catch locaux avec un message dédié (`'réponse task IAQ non-JSON'`).

### Remarques non bloquantes (hors format finding)

- **Pas de retry sur erreurs transitoires** (fetch échoué, task 5xx) : échec → fallback posté immédiatement, sans nouvelle tentative. Choix de conception cohérent avec l'existant (cerveau cli), assumé.
- **Statut inconnu dans le poll** : tout statut hors `completed`/`failed` (ex: `cancelled`, statut futur) boucle jusqu'au timeout au lieu d'échouer — défensif, acceptable.
- **Couverture de test** : manquent des cas — task renvoyant un statut ≠ 200, réponses non-JSON (submit et task), câblage `relay.mjs` en mode iaq (notamment que `log` est branché, cf. M1). Les 9 tests existants sont corrects et rapides (stubs HTTP locaux, pas de réseau).

---

## Axes vérifiés sans finding

- **Sécurité — token** : le token n'est jamais loggé ni dans les messages d'erreur ni dans l'URL (header `Authorization` uniquement) ; les messages `err.message` de fetch Node ne contiennent ni URL ni headers ; `relay.log` historique sans token ni header. ✓
- **AbortSignal sur CHAQUE fetch** : submit, poll et artifact passent tous par `fetchWithDeadline` avec AbortController individuel, timer nettoyé en `finally`. ✓
- **Timeout global** : deadline unique partagée, chaque fetch borné par `remainingTimeout = Math.max(0, deadline - Date.now())`. ✓
- **Boucle de poll bornée** : condition `while (Date.now() < deadline)` — la boucle ne peut pas dépasser la deadline ; le sleep ne dépasse pas la deadline (`Math.min(IAQ_POLL_INTERVAL_MS, remainingTimeout)`). ✓
- **Ordre de traitement du poll** : `completed` → break ; `failed` → return immédiat **avant** le sleep. ✓
- **201 strict au submit** : seul 201 est accepté, tout autre statut → `{ok:false}` avec le statut. ✓
- **Artifact 404 (purge ~20 min)** : géré avec message dédié « résultat purgé ? ». ✓
- **Artifact vide** : `trim()` + vérification → `{ok:false} 'réponse vide du cerveau'`. ✓
- **Câblage** : `BRAIN_MODE` invalide → message clair + exit 1 ; mode iaq sans `IAQ_TOKEN` → message clair + exit 1 ; `parseTimeoutMs` corrige `Number("")=0` (fallback) et rejette NaN/négatif. ✓
- **Aucune dépendance npm ajoutée** : `package.json`/`package-lock.json` intacts au diff ; stdlib `fetch` global (déjà utilisé dans `cbor-client.mjs`/`mesgia-client.mjs`), node v24.18.0 constaté. ✓
- **Tests** : 38/38 verts, dont les 9 nouveaux (succès complet, 401, failed, artifact 404, artifact vide, borne 5000, timeout global, token jamais loggé, constante de timeout raisonnable). ✓

---

## Statut réel

- **Statut** : implémenté + testé (38/38), **non déployé** en mode iaq (daemon en prod tourne l'ancien code depuis avant le changement).
- **Prochaine étape** (hors périmètre review) : décider de M1 (branchement log) avant mise en service du mode iaq, puis basculer `BRAIN_MODE=iaq` dans `.env`, redémarrer le daemon et vérifier une inférence de bout en bout avec `relay.log`.
