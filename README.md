# Sinequa Doc Search — extension Chrome

Extension Chrome (Manifest V3) qui s'authentifie sur un backend Sinequa et interroge sa query
de recherche. Par défaut : `https://docsearch.sinequa.com`, app `tech-doc-ns`, query
`tech-doc-pf-ns-en_query` — d'autres environnements s'ajoutent dans la page d'options.

L'authentification reprend le pattern du CLI [`nodejs-atomic-sample`](../nodejs-atomic-sample)
(`login.js` / `refresh.js`), mais **simplifié par le contexte extension** : grâce aux host
permissions, les `fetch` de l'extension ne sont pas soumis au CORS et portent les cookies du
backend — plus besoin de serveur loopback local ni de snippet console.

> **Autres navigateurs** : l'extension fonctionne telle quelle sur **Edge** (Chromium) —
> `edge://extensions`, mode développeur, charger ce même dossier. Le portage **Firefox**
> vit dans [`firefox/`](firefox/README.md) — signature du `.xpi` :
> [ci-dessous](#firefox--signer-le-xpi-powershell).

## Installation (mode développeur)

1. Chrome → `chrome://extensions`
2. Activer **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → choisir ce dossier (`plugin-chrome`)
4. Épingler l'icône, ouvrir la popup → **Se connecter**

## Fonctionnement

### Authentification (background.js)

> Analyse détaillée (familles de serveurs, proxy authentifiant OIDC, séquences, limites) :
> [docs/login.md](docs/login.md)

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
| `icons/` | icônes PNG (16/32/48/128) — régénérables via `node icons/gen-icons.mjs` |

## Chrome : empaqueter (.zip / .crx signé)

En usage courant on charge le dossier non empaqueté (cf. [Installation](#installation-mode-développeur)).
Pour distribuer, deux formats — les artefacts vont dans `dist/` (gitignoré).

### `.zip` — Chrome Web Store

C'est le format attendu par la console développeur du store (et accepté en glisser-déposer sur
`chrome://extensions`). Seuls les fichiers runtime sont empaquetés — pas `icons/gen-icons.mjs`,
`docs/`, `README.md` ni `firefox/` :

```powershell
$ver  = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$out  = "dist\sinequa_doc_search-chrome-$ver.zip"
$stage = "dist\_stage"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$stage\icons" -Force | Out-Null
@('manifest.json','background.js','content.js','sinequa.js',
  'popup.html','popup.css','popup.js','options.html','options.css','options.js') |
  ForEach-Object { Copy-Item $_ "$stage\$_" }
Copy-Item icons\*.png "$stage\icons\"
Compress-Archive -Path "$stage\*" -DestinationPath $out -Force
Remove-Item $stage -Recurse -Force
```

> Le staging est nécessaire : `Compress-Archive` passant `icons\*.png` directement aplatirait
> les PNG à la racine de l'archive, alors que le manifest les référence sous `icons/`.

### `.crx` signé — distribution hors store

Pour un déploiement interne sans passer par le store. La signature repose sur une **clé privée
`.pem`** : la même clé ⇒ le même ID d'extension entre les mises à jour. Chrome la génère à la
première exécution si elle n'existe pas.

> ⚠️ **Un `.crx` self-signé ne s'installe PAS en glisser-déposer** sur Chrome stable : il
> manque la preuve de signature du Web Store, d'où l'erreur `CRX_REQUIRED_PROOF_MISSING`. Le
> double-clic / drag-and-drop est définitivement bloqué (le flag `--enable-easy-off-store-…`
> n'existe plus). Le `.crx` ne sert donc **que** via la policy d'entreprise ci-dessous ; pour
> un simple test, charger le dossier non empaqueté (cf. [Installation](#installation-mode-développeur)).

1. **Première fois — créer la clé + le `.crx`** (le dossier décompressé sert de source ; on peut
   réutiliser le staging du `.zip` ci-dessus, ici `dist\_pkg`) :

   ```powershell
   $ver  = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
   $pkg  = "dist\_pkg"
   Remove-Item $pkg -Recurse -Force -ErrorAction SilentlyContinue
   New-Item -ItemType Directory "$pkg\icons" -Force | Out-Null
   @('manifest.json','background.js','content.js','sinequa.js',
     'popup.html','popup.css','popup.js','options.html','options.css','options.js') |
     ForEach-Object { Copy-Item $_ "$pkg\$_" }
   Copy-Item icons\*.png "$pkg\icons\"

   $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
   & $chrome --pack-extension="$PWD\$pkg" --no-message-box
   # -> génère dist\_pkg.crx ET dist\_pkg.pem (la clé, créée car absente)

   Move-Item dist\_pkg.crx "dist\sinequa_doc_search-chrome-$ver.crx" -Force
   Move-Item dist\_pkg.pem  dist\sinequa_doc_search.pem -Force
   Remove-Item $pkg -Recurse -Force
   ```

2. **Mises à jour suivantes — réutiliser la même clé** (ID stable) en la passant à
   `--pack-extension-key` ; ne pas laisser Chrome en regénérer une :

   ```powershell
   & $chrome --pack-extension="$PWD\dist\_pkg" `
             --pack-extension-key="$PWD\dist\sinequa_doc_search.pem" --no-message-box
   ```

À savoir :

- **`sinequa_doc_search.pem` est une clé privée** — `dist/` est gitignoré, mais sauvegardez-la
  hors du repo : la perdre = nouvel ID d'extension (réinstallation complète côté utilisateurs).
  Une fuite permettrait de signer une fausse mise à jour ⇒ la régénérer et republier.
- **Déploiement interne réel** : héberger le `.crx` **et** un manifeste `update.xml` (qui
  déclare l'ID, la version et l'`codebase` = URL du `.crx`) sur un serveur, puis forcer
  l'installation via la policy `ExtensionInstallForcelist` (registre Windows
  `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`, valeur
  `<id>;<url-de-update.xml>`, ou GPO). La policy lève le `CRX_REQUIRED_PROOF_MISSING`. Edge
  accepte la même clé et le même `.crx` (clés `…\Policies\Microsoft\Edge\…`).
  → kit prêt à l'emploi (`update.xml` + script de policy) : [`deploy/chrome/`](deploy/chrome/README.md).
- l'ID d'extension dérivé de la clé s'affiche après le packaging dans `chrome://extensions`.

## Firefox : signer le .xpi (PowerShell)

Firefox **release** n'installe que des extensions signées par Mozilla (la pref
`xpinstall.signatures.required` y est ignorée — elle n'agit que sur ESR / Developer Edition).
La signature passe par addons.mozilla.org en canal **unlisted** : le `.xpi` est signé mais
**pas publié** sur le store.

1. **Identifiants API AMO** (compte Firefox gratuit) : générer le couple *JWT issuer* / *JWT
   secret* sur <https://addons.mozilla.org/developers/addon/api/key/>
2. **Signer** (depuis la racine du repo) :

   ```powershell
   $env:WEB_EXT_API_KEY = "user:XXXXXXX:XXX"   # JWT issuer
   $env:WEB_EXT_API_SECRET = "le-jwt-secret"
   npx web-ext sign --source-dir firefox --channel unlisted --artifacts-dir dist
   ```

   `web-ext` lit les deux variables d'environnement, soumet le paquet, attend la validation
   AMO (généralement < 1 min en unlisted) et télécharge le `.xpi` **signé** dans `dist/`.
3. **Installer** : double-clic sur le `.xpi`, ou `about:addons` → ⚙ → **Installer un module
   depuis un fichier…** — installation durable, aucune pref à toucher, fonctionne sur tous
   les Firefox (même `gecko.id` → un nouveau `.xpi` remplace l'ancien).

À savoir :

- AMO refuse de re-signer une version déjà soumise → **incrémenter `version`** dans
  `firefox/manifest.json` avant chaque nouvelle signature
- les `$env:` ne vivent que le temps de la session PowerShell — ne pas committer les
  identifiants ; en cas de fuite, les révoquer/régénérer sur la page des clés API
- test rapide sans signature : `about:debugging` → chargement temporaire
  (cf. [firefox/README.md](firefox/README.md))

## Debug

- Service worker : `chrome://extensions` → carte de l'extension → **service worker** (console —
  les renouvellements y sont tracés `[refresh] <env> : …`)
- Popup : clic droit sur la popup → **Inspecter**
- État stocké : dans une de ces consoles, `chrome.storage.local.get(console.log)`
