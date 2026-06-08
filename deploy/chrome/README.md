# Déploiement interne du `.crx` (force-install)

Distribution du `.crx` self-signé **sans Chrome Web Store**, via policy `ExtensionInstallForcelist`.
C'est la seule voie qui lève le `CRX_REQUIRED_PROOF_MISSING` (le glisser-déposer reste bloqué).

| | |
|---|---|
| **Extension ID** | `fgcpjinnkonfnkfflpefjpgmfcaefigf` |
| Clé de signature | `dist/sinequa_doc_search.pem` (privée — hors repo, à sauvegarder) |

## Vue d'ensemble

```
poste client ──policy(forcelist)──> update.xml ──codebase──> sinequa_doc_search-chrome-<v>.crx
   (registre HKLM)                  (auto-hébergé)            (auto-hébergé)
```

Le navigateur lit l'ID + l'URL du `update.xml` dans le registre, télécharge le `update.xml`,
y lit la `version` et l'URL `codebase` du `.crx`, puis l'installe et le maintient à jour.

## Mise en place (une fois)

1. **Empaqueter le `.crx`** (avec la clé existante — cf. [README racine](../../README.md#crx-signé--distribution-hors-store)).
2. **Héberger** sur un serveur HTTP(S) interne (ou un partage SMB) accessible des postes :
   - `sinequa_doc_search-chrome-<version>.crx`
   - `update.xml`
3. **Renseigner les URL** dans `update.xml` :
   - `codebase` = URL directe du `.crx`
   - `version` = version du `manifest.json` empaqueté
4. **Appliquer la policy** sur chaque poste (admin) — `-UpdateUrl` pointe le `update.xml` :

   ```powershell
   .\force-install.ps1 -UpdateUrl "https://srv.intranet/sinequa/update.xml"
   # + Edge : -IncludeEdge ; partage SMB : -UpdateUrl "file:///\\srv\deploy\sinequa\update.xml"
   ```

5. **Vérifier** : `chrome://policy` → *Recharger les stratégies* ; `chrome://extensions` doit
   afficher l'extension « Installée par votre administrateur ».

## Mises à jour

Garder **la même clé `.pem`** (ID stable). Pour publier une nouvelle version :

1. bumper `version` dans `manifest.json`, ré-empaqueter le `.crx`,
2. déposer le nouveau `.crx` sur le serveur,
3. mettre à jour `version` + `codebase` dans `update.xml`.

Les navigateurs détectent le changement au prochain cycle de mise à jour (ou via
`chrome://extensions` → *Tout mettre à jour*). La policy n'a pas à être retouchée.

## Désinstaller la policy

```powershell
# Chrome — retirer l'entrée (adapter l'index si plusieurs extensions forcées)
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" -Name "1"
```
