# Sinequa Doc Search — extension Chrome

Extension Chrome (Manifest V3) qui s'authentifie sur un backend Sinequa et interroge sa query
de recherche. Par défaut : `https://docsearch.sinequa.com`, app `tech-doc-ns`, query
`tech-doc-pf-ns-en_query` — d'autres environnements s'ajoutent dans la page d'options.

L'authentification reprend le pattern du CLI [`nodejs-atomic-sample`](../nodejs-atomic-sample)
(`login.js` / `refresh.js`), mais **simplifié par le contexte extension** : grâce aux host
permissions, les `fetch` de l'extension ne sont pas soumis au CORS et portent les cookies du
backend — plus besoin de serveur loopback local ni de snippet console.

## Installation (mode développeur)

1. Chrome → `chrome://extensions`
2. Activer **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → choisir ce dossier (`plugin-chrome`)
4. Épingler l'icône, ouvrir la popup → **Se connecter**

## Fonctionnement

### Authentification (background.js)

1. **Silencieux d'abord** : si un cookie de session Sinequa existe déjà (vous êtes passé sur
   le backend récemment), l'échange cookie → JWT se fait sans rien ouvrir.
2. Sinon, **flow interactif** :
   - `GET api/v1/app?preLogin=true` → découverte du provider OAuth (`autoOAuthProvider`)
   - `POST api/v1/security.oauth { action: "getcode", tokenInCookie: true }` → URL de login
   - ouverture d'un onglet sur la page de login (Keycloak) — *la popup se ferme à ce moment,
     c'est normal : le service worker termine le flow seul*
   - au retour de l'onglet sur le backend (cookie de session posé), échange cookie → JWT :
     `GET challenge?action=getCsrfToken` → `POST security.webtoken { tokenInCookie: false }`
   - le JWT est **validé** par une vraie query avant d'être stocké (`chrome.storage.local`),
     l'onglet est fermé, le badge ✓ s'affiche
3. Rouvrir la popup : connecté.

### Cycle de vie du token

- **Renouvellement proactif** (pattern `refresh.js` du sample) : une alarme horaire
  (`chrome.alarms`) renouvelle en Bearer (`security.webtoken`) tout token qui expire dans
  moins de 24 h — le login navigateur ne sert qu'au bootstrap ou après expiration
- quand le serveur renvoie un header `sinequa-jwt-refresh` sur une recherche, le token
  stocké est aussi renouvelé au fil de l'eau
- expiration vérifiée localement (claim `exp`) à chaque ouverture de popup ; `401` sur une
  recherche → retour à l'état déconnecté

### Multi-environnements (options.html)

Équivalent des `.env.<nom>` du CLI : chaque environnement = `{ nom, backendUrl, app, query? }`,
avec **un token par environnement**, stocké dans `chrome.storage.local`. Le nom de query est
optionnel — résolu depuis la config de l'app (`defaultQueryName`, sinon première query, sinon
`_query`), comme le REPL du sample.

- ⚙ dans la popup → options en **dialog native** par-dessus `chrome://extensions`
  (ajout / modification / suppression — suppression en deux temps, `confirm()` y est bloqué)
- le sélecteur en haut de la popup bascule l'environnement actif (l'équivalent de `.use <nom>`)
- les backends hors `docsearch.sinequa.com` passent par `optional_host_permissions` :
  Chrome demande la permission à l'enregistrement de l'environnement (ou au login)

### Palette (raccourci clavier — `Ctrl+Maj+Espace`)

Une palette de recherche façon « Spotlight », injectée dans la page courante (`content.js`,
Shadow DOM — aucun conflit de style avec la page) :

- **`Ctrl+Maj+Espace`** (configurable : `chrome://extensions/shortcuts`) ouvre/ferme la palette —
  centrée à l'écran, elle **remonte vers le haut** dès que des résultats s'affichent
- recherche **au fil de la frappe** (debounce 220 ms, dès 2 caractères)
- 100 % clavier : **↑/↓** (ou Tab) sélectionnent, **↵** ouvre dans un nouvel onglet,
  **Ctrl+↵** ouvre en arrière-plan, **Échap** ferme
- le raccourci accorde `activeTab` : l'injection (`scripting`) ne demande aucune host
  permission supplémentaire ; les requêtes passent par le service worker (le token n'est
  jamais exposé à la page)
- pages non injectables (`chrome://`, Web Store…) : repli sur la popup
- non connecté → bouton **Se connecter** directement dans la palette
- le **badge d'environnement est un sélecteur** (dès qu'il y a plusieurs environnements) :
  en changer bascule l'actif — partagé avec popup et omnibox —, tente une connexion
  silencieuse sur le nouveau backend et rejoue la recherche en cours

### Omnibox (mot-clé `sq`)

Dans la barre d'adresse : `sq` puis espace, puis le texte — les suggestions arrivent en
direct (titres des 6 premiers résultats de l'environnement actif, debounce 250 ms) :

- **sélectionner une suggestion** ouvre le document (`url1`) — Maj/Ctrl pour le choix de l'onglet
- **Entrée sur le texte brut** ouvre la popup pré-remplie avec la recherche lancée
  (repli : ouvre directement le premier résultat si Chrome refuse d'ouvrir la popup)
- non connecté → la ligne par défaut l'indique ; Entrée ouvre la popup pour se connecter

### Recherche (popup.js)

`POST api/v1/query` avec le payload exact de la lib `@sinequa/atomic` :

```json
{
  "app": "tech-doc-ns",
  "query": { "name": "tech-doc-pf-ns-en_query", "text": "…" },
  "locale": "en",
  "noUserOverride": true,
  "noAutoAuthentication": true
}
```

Affichage : titre (lien `url1`), extraits pertinents (texte brut), `treepath`, total.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3 — host permissions (clé du mécanisme), `alarms`, omnibox, commande clavier, options |
| `sinequa.js` | client API (paramétré par environnement) + stockage environnements/tokens |
| `background.js` | service worker — login (silencieux puis interactif), renouvellement horaire, omnibox, palette |
| `content.js` | palette « Spotlight » injectée à la demande (Shadow DOM, navigation clavier) |
| `popup.html/css/js` | UI : environnement actif, statut, recherche, résultats (navigation clavier) |
| `options.html/css/js` | gestion des environnements (dialog embarquée, cartes) |

## Debug

- Service worker : `chrome://extensions` → carte de l'extension → **service worker** (console —
  les renouvellements y sont tracés `[refresh] <env> : …`)
- Popup : clic droit sur la popup → **Inspecter**
- État stocké : dans une de ces consoles, `chrome.storage.local.get(console.log)`
