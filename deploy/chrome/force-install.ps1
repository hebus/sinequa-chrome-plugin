<#
.SYNOPSIS
  Force-installe l'extension Sinequa Doc Search (.crx self-signé) via policy de registre HKLM.
  Lève le blocage CRX_REQUIRED_PROOF_MISSING : la policy autorise l'ID et fait télécharger
  le .crx depuis l'update.xml auto-hébergé.

.DESCRIPTION
  Écrit HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist (et Edge si -IncludeEdge).
  Valeur = "<extensionId>;<updateUrl>". À exécuter en administrateur.

  Prérequis côté serveur : update.xml ET le .crx hébergés et accessibles depuis les postes.
  -UpdateUrl pointe vers le update.xml (pas vers le .crx — c'est l'update.xml qui pointe le .crx).

.EXAMPLE
  .\force-install.ps1 -UpdateUrl "https://srv.intranet/sinequa/update.xml"

.EXAMPLE
  # Hébergement sur partage SMB :
  .\force-install.ps1 -UpdateUrl "file:///\\srv\deploy\sinequa\update.xml" -IncludeEdge
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$UpdateUrl,

  [string]$ExtensionId = "fgcpjinnkonfnkfflpefjpgmfcaefigf",

  [switch]$IncludeEdge
)

$ErrorActionPreference = "Stop"

function Set-Forcelist {
  param([string]$PolicyPath, [string]$Browser)

  if (-not (Test-Path $PolicyPath)) { New-Item -Path $PolicyPath -Force | Out-Null }

  # Trouve le prochain index libre (les entrées sont nommées "1", "2", ...) ;
  # réutilise l'index si l'ID est déjà présent (idempotent).
  $existing = Get-Item -Path $PolicyPath
  $entry = "$ExtensionId;$UpdateUrl"
  $slot = $null
  foreach ($name in $existing.GetValueNames()) {
    if (($existing.GetValue($name)) -like "$ExtensionId;*") { $slot = $name; break }
  }
  if (-not $slot) {
    $used = $existing.GetValueNames() | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
    $slot = (($used | Measure-Object -Maximum).Maximum + 1)
    if (-not $slot -or $slot -lt 1) { $slot = 1 }
  }

  New-ItemProperty -Path $PolicyPath -Name "$slot" -Value $entry -PropertyType String -Force | Out-Null
  Write-Host "[$Browser] $PolicyPath -> [$slot] = $entry"
}

Set-Forcelist -PolicyPath "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" -Browser "Chrome"
if ($IncludeEdge) {
  Set-Forcelist -PolicyPath "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist" -Browser "Edge"
}

Write-Host ""
Write-Host "Fait. Redémarrer le navigateur (ou 'chrome://policy' -> Recharger les stratégies)."
Write-Host "Vérifier : chrome://extensions doit montrer l'extension installée et 'Installée par votre administrateur'."
