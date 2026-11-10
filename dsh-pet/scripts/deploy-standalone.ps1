<#
.SYNOPSIS
  Guarded build + deploy of the standalone pet (D:\App\dsh-pet). The ONLY supported way to deploy.

.DESCRIPTION
  Refuses to deploy unless:
    1. the checkout is clean (no modified or untracked files): nothing uncommitted can ship;
    2. HEAD is exactly the freshly fetched origin/<Branch> tip: only merged code ships;
    3. the installed package still matches its deploy-manifest.json (asar hash): nobody hand-patched it;
    4. the commit recorded in that manifest is an ancestor of HEAD: the new build contains everything
       that is live now, so a deploy can never silently drop a shipped feature.
  On success it writes deploy-manifest.json next to the exe and checks /health for the package version.

  Background (2026-11-10): OpenRouter usage and the Huniu alert title were deployed by patching the installed
  asar from an uncommitted working tree; the next rebuild from custom (dfh.20) dropped both.

  Run it outside the MSIX container, e.g.:
    & D:\App\outside-runner\run-outside.ps1 -WorkDir <worktree>\dsh-pet -Command 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-standalone.ps1'

.PARAMETER CheckOnly
  Run the guards only; do not build or deploy.
.PARAMETER AdoptUnmanaged
  Allow a first deploy over an install that has no manifest yet (after you verified it by other means).
#>
param(
  [string]$InstallDir = 'D:\App\dsh-pet',
  [string]$Branch = 'custom',
  [string]$TaskName = 'DSH Pet Standalone',
  [switch]$CheckOnly,
  [switch]$AdoptUnmanaged
)
$ErrorActionPreference = 'Stop'
function Fail([string]$msg) { Write-Output "DEPLOY REFUSED: $msg"; exit 2 }

$pkgDir = Split-Path -Parent $PSScriptRoot
Set-Location $pkgDir

# 1. clean checkout
$dirty = git status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0) { Fail 'git status failed' }
if ($dirty) { Fail "working tree is not clean:`n$($dirty -join "`n")" }

# 2. HEAD == origin/<Branch>
git fetch -q origin $Branch
if ($LASTEXITCODE -ne 0) { Fail "git fetch origin $Branch failed" }
$head = (git rev-parse HEAD).Trim()
$tip = (git rev-parse "origin/$Branch").Trim()
if ($head -ne $tip) { Fail "HEAD $head is not origin/$Branch tip $tip (merge first, then build from the tip)" }

# 3 + 4. installed package matches its manifest, and is contained in HEAD
$manifestPath = Join-Path $InstallDir 'deploy-manifest.json'
$asarPath = Join-Path $InstallDir 'resources\app.asar'
if (Test-Path $manifestPath) {
  $live = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $liveHash = (Get-FileHash $asarPath -Algorithm SHA256).Hash
  if ($liveHash -ne $live.asarHash) { Fail "installed app.asar was modified after deploy of $($live.commit) (hand patch?). Commit that change and merge it first." }
  git merge-base --is-ancestor $live.commit $head
  if ($LASTEXITCODE -ne 0) { Fail "live build $($live.commit) ($($live.version)) is not contained in $head; deploying would drop shipped code." }
} elseif (-not $AdoptUnmanaged) {
  Fail "no $manifestPath; verify the live install by hand, then rerun with -AdoptUnmanaged"
}

$version = (Get-Content (Join-Path $pkgDir 'package.json') -Raw | ConvertFrom-Json).version
Write-Output "guards OK: $head ($version)"
if ($CheckOnly) { exit 0 }

# build
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }
npm run dist
if ($LASTEXITCODE -ne 0) { Fail 'npm run dist failed' }
$out = Join-Path $pkgDir 'dist-app\win-unpacked'

# deploy: backup, stop, mirror, manifest, start
$backup = Join-Path (Split-Path -Parent $InstallDir) ("dsh-pet-backup\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
robocopy $InstallDir $backup /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "backup failed ($LASTEXITCODE)" }
Stop-ScheduledTask -TaskName $TaskName
Start-Sleep 3
Get-CimInstance Win32_Process -Filter "Name='dsh-pet.exe'" |
  Where-Object { $_.ExecutablePath -eq (Join-Path $InstallDir 'dsh-pet.exe') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
robocopy $out $InstallDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "mirror failed ($LASTEXITCODE); restore from $backup" }
$newHash = (Get-FileHash $asarPath -Algorithm SHA256).Hash
[pscustomobject]@{
  commit     = $head
  branch     = $Branch
  version    = $version
  asarHash   = $newHash
  deployedAt = (Get-Date).ToString('o')
  backup     = $backup
} | ConvertTo-Json | Set-Content $manifestPath -Encoding UTF8
Start-ScheduledTask -TaskName $TaskName
# keep the 3 newest backups
Get-ChildItem (Split-Path -Parent $backup) -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

# verify /health
Start-Sleep 12
$log = Get-Content (Join-Path $env:USERPROFILE '.dsh\dsh-pet\logs.txt') -Encoding UTF8 -Tail 100
$m = [regex]::Matches(($log -join "`n"), '\[dsh-pet-app\].*?(http://127\.0\.0\.1:\d+)')
if ($m.Count -eq 0) { Fail 'deployed, but no service address in log' }
$health = Invoke-RestMethod -Uri ($m[$m.Count - 1].Groups[1].Value + '/health') -TimeoutSec 10
if ($health.version -ne $version) { Fail "deployed, but /health reports $($health.version), expected $version" }
Write-Output "DEPLOYED $version from $head; asar $newHash; backup $backup"
