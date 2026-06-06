# Authentification — analyse du login

Comment l'extension établit la connexion à un backend Sinequa, selon la famille de serveur.
Le code vit dans `background.js` (orchestration) et `sinequa.js` (appels API + stockage).

> Vérifié en réel sur les deux familles : `docsearch.sinequa.com` (classique) et
> `insight.chapsvision.com` (proxy authentifiant) — `security.webtoken` émet bien un JWT
> derrière le proxy, le plan B « requêtes cookie seul » n'a pas été nécessaire.

## Deux familles de serveurs

| | Sinequa « classique » (ex. `docsearch.sinequa.com`) | Derrière un proxy authentifiant (ex. `insight.chapsvision.com`) |
|---|---|---|
| Qui authentifie | Sinequa lui-même (provider OAuth, ex. Keycloak) | Le proxy, en amont (OIDC silencieux) |
| Identité vue par Sinequa | Cookie de session Sinequa / JWT Bearer | En-tête injecté par le proxy (`OIDC_CLAIM_upn: user@chapsvision.com`) |
| API accessibles sans auth | Oui (`app?preLogin=true`, `security.oauth`) | **Non** — toute requête non authentifiée est redirigée vers l'IdP |
| Ce qu'il faut porter sur les requêtes | `Authorization: Bearer <jwt>` seul | Bearer **et** le cookie de session du proxy (`credentials: "include"`) |
| Flag sur l'environnement | — | `env.proxyAuth: true` (détecté automatiquement, persisté) |

En développement local contre ce type de serveur, on reproduit le proxy en injectant
soi-même l'en-tête : `"headers": { "OIDC_CLAIM_upn": "user@chapsvision.com" }` — en
production, le proxy détermine la valeur tout seul après l'OIDC.

## Flow silencieux (`trySilentLogin`, background.js)

Tenté en premier dans tous les cas — il suppose qu'une session existe déjà côté navigateur
(cookie Sinequa ou cookie du proxy, selon la famille).

1. Token encore valide en storage ? → fini.
2. Sinon, **échange cookie → JWT** (`exchangeCookieForTokens`, sinequa.js) :
   - `GET api/v1/challenge?action=getCsrfToken` avec `credentials: "include"` ;
   - `POST api/v1/security.webtoken { action: "get", tokenInCookie: false }` avec cookies,
     plus l'en-tête `Sinequa-csrf-token` **si** le challenge a renvoyé un `csrfToken`.
     Sans `csrfToken`, le webtoken est quand même tenté : derrière un proxy, la requête est
     authentifiée par le cookie du proxy (en-tête injecté), pas par une session Sinequa.
   - La réponse fournit des candidats JWT, priorisés (`webToken`, `token`, `jwt`,
     `access_token`…).
3. **Validation** (`firstValidToken`, background.js) : chaque candidat est essayé sur une
   vraie query (`isFirstPage: true`). Le premier qui passe est stocké.

### Détection automatique du mode proxy

Si **aucun** candidat ne passe en Bearer seul, `firstValidToken` réessaie en portant aussi
les cookies (`{ ...env, proxyAuth: true }`). Un succès dans ce mode persiste
`env.proxyAuth: true` via `patchEnv` : toutes les requêtes suivantes de cet environnement
(query, refresh, résolution de query) partiront avec `credentials: "include"`
(`authFetchOptions`, sinequa.js). Aucune configuration manuelle.

Pourquoi c'est nécessaire : sans son cookie de session, le proxy redirige la requête vers
l'IdP — un Bearer valide ne suffit pas à le franchir.

## Flow interactif (`interactiveLogin`, background.js)

Quand le silencieux échoue (aucune session nulle part) :

1. **Découverte de l'URL de login** (`discoverLoginUrl`) :
   - *classique* : `GET app?preLogin=true` → `autoOAuthProvider`, puis
     `POST security.oauth { action: "getcode", tokenInCookie: true }` → URL du provider ;
   - *repli proxy* : si cette découverte échoue (les API ne répondent pas avant
     authentification), l'URL de login est simplement `env.backendUrl/` — naviguer suffit,
     le proxy déroule l'OIDC (silencieux si une session IdP existe) et pose son cookie.
2. Un onglet s'ouvre sur cette URL (*la popup se ferme, c'est normal : le service worker
   termine le flow seul*).
3. À chaque navigation aboutie de l'onglet **sur le backend**, tentative d'échange
   cookie → JWT + validation. Les étapes intermédiaires (IdP, redirections) échouent sans
   bruit ; la tentative qui suit la pose du cookie réussit.
4. Token validé → stocké, onglet fermé, badge ✓. Timeout : 5 min.

## Séquence — cas proxy, première connexion

```
popup            service worker                proxy                IdP        Sinequa
  │ login            │                            │                  │            │
  │──────────────────▶ trySilentLogin             │                  │            │
  │                  │── challenge (cookies) ────▶│ pas de session   │            │
  │                  │                            │── redirect ─────▶│  (échec fetch)
  │                  │  ✗ silencieux              │                  │            │
  │                  │── preLogin ───────────────▶│ pas de session → ✗            │
  │                  │  repli : onglet sur backendUrl                │            │
  │                  │            [onglet]──────▶│── OIDC ─────────▶│            │
  │                  │            [onglet]◀── cookie proxy posé ◀────│            │
  │                  │── challenge + webtoken (cookies) ─▶│─ OIDC_CLAIM_upn ─────▶│
  │                  │◀──────────────── candidats JWT ──────────────────────────│
  │                  │── query Bearer seul ──────▶│ ✗ (redirigé IdP) │            │
  │                  │── query Bearer + cookies ─▶│──────────────────────────────▶│ ✓
  │                  │  proxyAuth persisté, token stocké, onglet fermé            │
```

## Cycle de vie du token (inchangé, mais avec cookies en mode proxy)

- **Renouvellement proactif** : alarme horaire → `security.webtoken` en Bearer pour tout
  token expirant dans moins de 24 h. En mode proxy, la requête porte aussi les cookies —
  elle ne passe que tant que le cookie du proxy vit.
- **Au fil de l'eau** : header `sinequa-jwt-refresh` sur une query → token remplacé.
- `HTTP 401` sur une recherche → token purgé, état déconnecté.

## Persistance du flag (options.js)

Modifier un environnement sans changer de backend **préserve** `proxyAuth` (sinon le token
conservé partirait en Bearer seul et serait redirigé par le proxy). Changer de backend ou
d'app invalide le token, et le flag repart de zéro — il sera re-détecté au prochain login.

## Limites connues

- **Expiration du cookie proxy** : les requêtes échouent alors en redirection IdP (erreur
  réseau / réponse HTML), pas en `401` propre — le message « Session expirée » ne se
  déclenche pas dans ce cas. Recliquer **Se connecter** relance le flux. Amélioration
  possible : détecter les réponses HTML/redirect et purger le token.
- L'échange silencieux côté proxy ne marche que si le navigateur possède déjà un cookie de
  session du proxy (visite récente de l'application) ; sinon le `challenge` est redirigé
  vers l'IdP, origine pour laquelle l'extension n'a pas de host permission → échec net,
  rattrapé par le flow interactif.
