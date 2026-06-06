# Sinequa Doc Search — extension Firefox

Portage Firefox (Manifest V3) de l'extension Chrome du dossier parent ([../README.md](../README.md)).
Mêmes fonctionnalités : authentification cookie → JWT sur un backend Sinequa, popup de recherche,
palette « Spotlight » (`Ctrl+Maj+Espace`), omnibox (mot-clé `sq`), multi-environnements,
renouvellement proactif des tokens.

> Analyse détaillée du login (familles de serveurs, proxy authentifiant OIDC) :
> [../docs/login.md](../docs/login.md)

## Installation

### Chargement temporaire (développement)

1. Firefox → `about:debugging#/runtime/this-firefox`
2. **Charger un module complémentaire temporaire…** → choisir `firefox/manifest.json`
3. Épingler l'icône, ouvrir la popup → **Se connecter**

⚠️ Un module temporaire disparaît au redémarrage de Firefox. Pour une installation durable :
signature sur addons.mozilla.org (canal *unlisted*, `web-ext sign` — procédure PowerShell
détaillée : [../README.md](../README.md#firefox--signer-le-xpi-powershell)), ou Firefox
Developer Edition / ESR avec `xpinstall.signatures.required = false` dans `about:config`.

## Différences avec la version Chrome

Le code est quasi identique — Firefox fournit le namespace `chrome.*` et, en MV3, ses API
renvoient des promesses comme `browser.*`. Les seules adaptations :

| Quoi | Chrome | Firefox |
|---|---|---|
| Arrière-plan | `background.service_worker` | `background.scripts` (event page — Firefox MV3 n'exécute pas les service workers) |
| Identité | — | `browser_specific_settings.gecko` : `id`, `strict_min_version: 140.0` (clé `data_collection_permissions` exigée par AMO), `data_collection_permissions: none` |
| Omnibox | descriptions avec balisage XML (`<match>`, `<dim>`) et `%s` | texte brut (Firefox n'interprète pas le balisage) |
| Options | dialog native par-dessus `chrome://extensions` | en ligne dans `about:addons`, onglet **Préférences** de l'extension |
| Raccourci clavier | `chrome://extensions/shortcuts` | `about:addons` → ⚙ → **Gérer les raccourcis d'extensions** |

### Host permissions

En MV3, Firefox traite les `host_permissions` comme révocables : elles sont proposées à
l'installation mais l'utilisateur peut les refuser ou les retirer (`about:addons` → fiche de
l'extension → **Permissions**). Sans l'accès à `docsearch.sinequa.com`, la connexion
silencieuse échoue ; le bouton **Se connecter** redemande la permission (comme pour les
backends ajoutés dans les options, qui passent par `optional_host_permissions` — mécanisme
identique à Chrome).

## Debug

- Page d'arrière-plan : `about:debugging#/runtime/this-firefox` → carte de l'extension →
  **Examiner** (console — les renouvellements y sont tracés `[refresh] <env> : …`)
- Popup : ouvrir la popup puis, dans la console ci-dessus, choisir son document dans le
  sélecteur de cadres (ou activer la *Browser Toolbox*)
- État stocké : dans cette console, `await chrome.storage.local.get()`
