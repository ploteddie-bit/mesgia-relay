# Revue production — Patch auth dashboard IAQ Router — 2026-08-18

> Gabarit P5/P6 (charte production ExploDev). Réviseur indépendant, sans participation
> à l'écriture du patch et sans accès au serveur (lecture seule des sources locales).

## 1. Objet

- **Ce qui est déployé** : patch minimal sur 2 handlers de `src/dashboard.rs` du service
  IAQ Router 0.8.1 (`ia-general`, `10.0.0.223:8001`, exposé via `iaq.explodev.fr`).
  Diffs §3.1 (`api_monitoring`) et §3.2 (`api_ci_status`) de
  `PATCH-PROPOSITION.md`. **Le diff §3.3 (`/version`) est explicitement hors périmètre**
  (option B différée).
- **Sources revues** : `/home/eddie/iaq-auth-work/src/dashboard.rs` (complet, 499 l.),
  `api.rs` (extrait 271 l., fichier complet 1032 l. sur le serveur), `main.rs`.
- **Critères d'acceptation (P1)** :
  - Succès : `GET /api/monitoring` et `GET /api/ci_status` passent 401 sans token,
    403 mauvais token, 200 avec le bon Bearer ; `/health`, les pages HTML et `/version`
    restent inchangés (200) ; aucun script LAN critique cassé (hors sonde WSL à mettre à
    jour séparément) ; build Rust OK sans import ajouté.
  - Échecs (à prouver) : dépendance Redis down (les `unwrap_or*` du monitoring masquent
    l'erreur en données vides, comportement inchangé) ; fichier `/var/log/iaq/ci.log`
    absent → `{"available":false}` en 200 avec token ; tunnel public ne transmet aucun
    header → 401 sur les 2 routes.

## 2. Constantes introduites/modifiées (P2)

| Constante | Valeur | Justification |
|---|---|---|
| — | — | — |

Aucune constante nouvelle ni modifiée. Le token (`s.router_token`) et le chemin
`/var/log/iaq/ci.log` (hardcodé, inchangé) sont préexistants.

## 3. Tests d'échec exécutés (P3)

Non exécutés par le réviseur (pas d'accès serveur ; les sources locales sont un extrait
non compilable en l'état — `api.rs` contient des sections `[omis]`). À exécuter **avant**
déploiement :

| Scénario d'échec | Comment tester | Résultat brut attendu |
|---|---|---|
| Redis / store down | `curl -H "Authorization: Bearer $T" $B/api/monitoring` après coupure Redis | 200 avec `queue:0, stats:{}` (masqué par `unwrap_or*`) — pas de 5xx, **comportement inchangé** par le patch |
| `ci.log` absent | `curl -H "Authorization: Bearer $T" $B/api/ci_status` sur un hôte sans `/var/log/iaq/ci.log` | 200 `{"available":false}` — **chemin d'échec (early-return) non couvert par le plan §6** |
| Entrée invalide | header `Authorization: Bearer` (sans valeur) / `Basic xyz` | 401 (strip_prefix échoue) |
| Token vide côté serveur | N/A en prod (E7 fail-closed dans `main.rs:51-70`) | service ne démarre pas sans token |

## 4. Chemins d'échec — observabilité (P4)

- Le diff n'introduit **aucun** refus/retry/fallback nouveau : `auth()` retourne
  `401/403` en `StatusCode` pur, sans log ni corps — cohérent avec l'existant
  (`api_stats`, `api_tasks`, etc.).
- **Chemins silencieux du diff : aucun.** Le token n'est jamais loggé (`auth()` fait une
  simple comparaison en mémoire, `api.rs:148-159`) ; les handlers ne loggent pas le
  header.
- **Écart de couverture (hors diff, à traiter en second patch)** : les données de
  `/api/monitoring` (queue/current/stats) restent exposées publiquement par des routes
  voisines non protégées — voir **M1**. Ce n'est pas un chemin silencieux du diff, mais
  une fuite préexistante qui limite la portée réelle du patch.

## 5. Revue indépendante (P5)

- **Réviseur** : subagent indépendant, 2026-08-18. Vérification statique des 3 fichiers
  sources locaux + relecture de `PATCH-PROPOSITION.md` ; pas d'exécution (pas d'accès
  serveur, sources partielles).
- **Points relevés** : 0 bloquant, 1 majeur (M1), 6 mineurs (L1–L6).

### Findings

#### M1 (MEDIUM) — Fuites équivalentes restent publiques : objectif de confidentialité partiel

Le patch protège bien les 2 routes visées, mais les données qu'elles exposent sont en
grande partie accessibles **sans auth** par des routes adjacentes déjà en place :

- `GET /health` (`dashboard.rs:39,98-108`) renvoie `{status, queue, current, stats}` —
  strictement l'essentiel du corps de `/api/monitoring`, sans auth, et **doit rester
  public** (sonde liveness du watchdog tunnel).
- `GET /status` (`api.rs:120`, handler hors extrait) renvoie `queue/current/stats`, public.
- `GET /dashboard/vram` (`api.rs:140,226-244`) renvoie `free_mb/usage_mb/total_mb`, public.
- `GET /api/agent_profiles` (`dashboard.rs:57,195-197`) renvoie les profils d'agents, public.
- `GET /ws` (`dashboard.rs:46,317-319`) broadcast des événements sans auth.

Le patch ferme néanmoins des fuites **sans équivalent public exact** : le détail des runs
CI (`log_path`, `last`, `total_entries`, `ok_count`/`ko_count` — unique à `/api/ci_status`),
ainsi que `vram_peaks`, `version.build_time` et `features` (uniques à `/api/monitoring`).

**Impact** : déployé seul, le patch ne fait pas disparaître la fuite "queue/current/stats"
du tunnel public ; il ne couvre que la partie CI + peaks/version. La proposition le
documente honnêtement (§2.3) et le renvoie à un second patch décisionnel.

**Recommandation (non bloquante pour ce diff)** : traiter en priorité `/health` en le
réduisant à `{"status":"ok"}` (c'est la sonde du watchdog, elle n'a besoin que du 200),
puis trancher `/status`, `/dashboard/vram`, `GET /api/agent_profiles` et `/ws` dans le
second patch. Ne pas bloquer le déploiement de ce patch sur ces points : il ferme déjà
deux fuites spécifiques et n'en crée aucune.

#### L1 (LOW) — Plan de tests §6 incomplet : early-return de `api_ci_status` non testé

Le plan §6 teste 401/403/200 sur `/api/ci_status`, mais **pas** le chemin d'échec
"fichier `/var/log/iaq/ci.log` absent → `Ok((StatusCode::OK, Json({"available":false})))`"
(`dashboard.rs:459-461` modifié par §3.2). Ce chemin est le seul retour anticipé de la
fonction après le patch ; il doit être couvert pour valider la signature
`Result<impl IntoResponse, StatusCode>` dans **toutes** les branches.

#### L2 (LOW) — Plan de tests §6 sans étape de compilation (preuve build absente)

Le gabarit P6 exige la « sortie du build ». §6 n'inclut ni `cargo check` ni `cargo build`.
Le diff est trivial et les imports (`HeaderMap`, `StatusCode`, `State`, `Json`) sont déjà
présents (`dashboard.rs:1-12`), mais un `cargo check --all-targets` sur le serveur est
requis comme preuve avant déploiement. (Vérifiable uniquement côté serveur : les sources
locales `api.rs` sont un extrait `[omis]` non compilable en l'état.)

#### L3 (LOW) — Fenêtre de faux positif sur la sonde WSL `iaq-sondes-secu.sh`

`/home/eddie/iaq-sondes-secu.sh` attend `/api/monitoring` public (§4.2 de la proposition).
La mise à jour est planifiée « séparément après déploiement » → il existe une fenêtre où
la sonde reçoit 401. Impact faible (sonde, pas un consommateur critique) mais à coordonner :
mettre à jour la sonde **immédiatement après** (ou avant) le redéploiement pour éviter une
fausse alerte « service down ».

#### L4 (LOW) — Référence de ligne approximative pour `auth()`

§1.3 de la proposition situe `auth()` « ~ligne 265 » dans `api.rs`. Dans l'extrait fourni,
elle est en `api.rs:148` (numérotation du fichier complet 1032 l. différente). Cosmétique,
sans impact sur le patch.

#### L5 (LOW) — Diff §3.2 tronqué au milieu du corps de la fonction

Le diff §3.2 comporte un `@@` qui omet `if let Ok(v) = ... { entries.push(v); }`,
`let last`, et le bloc `ko_count` (`dashboard.rs:463-477`). La structure complète est
cohérente d'après le source fourni (toutes les branches `Ok` ont le même type
`(StatusCode, Json<Value>)`), mais le diff appliqué sur le serveur devra inclure
l'intégralité jusqu'au `Ok(...)` final — vérifier que l'outil d'application ne tronque pas.

#### L6 (LOW) — `api_monitoring` continue d'exposer version/features/build_time (authentifié)

Le corps de `/api/monitoring` inclut `version.service/version/git_sha/build_time/features`
(`dashboard.rs:366-372`) — désormais derrière auth, inchangé pour les clients authentifiés.
Simple remarque : ces champs ne sont pas une régression du patch, mais confirment que la
sensibilité réelle de la route dépasse « queue/current/stats ».

### Axes vérifiés sans finding

- **Correction Rust — signatures** : `State(s): State<DashboardState>, headers: HeaderMap`
  puis retour `Result<impl IntoResponse, StatusCode>` sont valides en axum (aucun extracteur
  de body ; `HeaderMap`/`State` sont `FromRequestParts`). Le `?` sur
  `crate::api::auth(&headers, &s.router_token)?` est typé exactement (`StatusCode`).
- **Correction Rust — types cohérents** : `api_monitoring` : l'ancien tuple
  `(StatusCode, Json)` est correctement enveloppé dans `Ok(...)` ; `api_ci_status` : les
  **deux** branches (early-return `available:false` et retour final) sont bien `Ok((...))`
  de même type `(StatusCode, Json<Value>)`. Aucune branche `impl IntoResponse` divergente.
- **Imports déjà présents** : `dashboard.rs:1-12` importe `HeaderMap`, `StatusCode`,
  `State`, `Json`, `IntoResponse` ; `crate::api::auth` est accessible. Aucun import à
  ajouter — confirmé.
- **Auth en première instruction** : dans les deux handlers, l'appel `auth(...)?` précède
  tout accès `store`/`fs` (`dashboard.rs:200` pour monitoring, `:238` pour ci_status dans le
  diff). Conforme au pattern des voisins `api_stats`/`api_tasks`.
- **Pas de fuite de token** : `auth()` (`api.rs:148-159`) ne journalise rien ; comparaison
  en mémoire ; aucun log du header ou du token dans les handlers.
- **Pas de contournement de route** : `build_app_with_vram` (`api.rs:116-143`) ne déclare
  **ni** `/api/monitoring` **ni** `/api/ci_status` ; pas de route dupliquée dans
  `router()` (`dashboard.rs:31-60`). Le `merge` (`main.rs:135`) ne masque rien ici.
- **Régression `api_ci_status`** : l'ajout de `State` est compatible avec l'enregistrement
  `.route("/api/ci_status", get(api_ci_status))` (`dashboard.rs:56`) grâce à
  `.with_state(state)` (`dashboard.rs:59`). Aucun changement de route.
- **`/version` non touché** : aucun risque de boucle de redémarrage du watchdog
  `iaq-tunnel-watchdog` (sonde `curl -sf .../version`). Le diff §3.3 est bien exclu.
- **`/health` non touché** : liveness préservé (200), tunnel et watchdog opérationnels.

## 6. Verdict

- [x] **GO — déployable** (déployer uniquement les diffs §3.1 et §3.2 ; §3.3 NON inclus)
- [ ] NO-GO — raisons : aucune bloquante

**Verdict : GO avec réserves non bloquantes.** La mécanique est correcte, minimale,
sans régression, sans contournement de route et sans fuite de token. Le périmètre demandé
par le propriétaire (2 routes) est exactement couvert. Réserve principale **M1** : l'objectif
de confidentialité reste partiel tant que `/status` et `/health` exposent `queue/current/stats`
publiquement — à traiter en second patch, sans bloquer celui-ci.

- **Réviseur humain** : Eddie, 2026-08-18 (revue à valider).

## 7. Preuves finales

- **Sortie des tests** : à fournir post-déploiement (401 sans token, 403 mauvais token,
  200 bon token sur les 2 routes ; `/health` et pages HTML 200 ; tunnel public 401 ;
  + le test early-return `ci.log` absent — cf. L1).
- **Sortie du build** : à fournir (`cargo check --all-targets` sur `ia-general`) — cf. L2.
- **Vérif post-déploiement** (à remplir après) : `curl` sur `10.0.0.223:8001` et
  `https://iaq.explodev.fr`, mise à jour `iaq-sondes-secu.sh` (cf. L3), re-run de la
  revue si §3.3 est finalement activé (option B : migrer le watchdog vers `/health` d'abord).
