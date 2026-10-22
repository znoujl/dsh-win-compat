#requires -Version 5.1
<#
.SYNOPSIS
  Verify dsh-win-compat against a real DeepSeek Harness installation.

.DESCRIPTION
  Creates a throwaway DSH home, installs this plugin into a copy of the shipped
  `web` profile with the Desktop-installed `dsh` command, then proves the loop:

    1. a pre-broken pnpm.cmd is repaired when the host boots;
    2. a second host boot leaves the repaired file untouched (restart-safe);
    3. rewriting the shim while the host runs is repaired by the watcher.

  Everything happens under a temporary DSH_HOME; the user's real profile is
  never touched. The temporary home is removed unless -KeepHome is passed.

.EXAMPLE
  pwsh -File scripts/verify-in-real-dsh.ps1
#>
param(
  [string]$CliPath = '',
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 58997,
  [string]$TestHome = '',
  [switch]$KeepHome
)

$ErrorActionPreference = 'Stop'

function Write-Ok([string]$Message) { Write-Host "ok   $Message" -ForegroundColor Green }
function Write-Section([string]$Message) { Write-Host "`n== $Message" -ForegroundColor Cyan }
function Stop-Fail([string]$Message) { Write-Host "FAIL $Message" -ForegroundColor Red; exit 1 }

function Resolve-DshCli {
  if ($CliPath) {
    if (-not (Test-Path $CliPath)) { Stop-Fail "dsh CLI not found: $CliPath" }
    return (Resolve-Path $CliPath).Path
  }
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    'C:\Users\anon\AppData\Local\Programs\DeepSeek Harness'
  ) | Select-Object -Unique
  foreach ($root in $roots) {
    $candidate = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $candidate) { return $candidate }
  }
  Stop-Fail 'Could not find the Desktop-installed dsh CLI. Pass -CliPath.'
}

function Read-Shim([string]$Path) { [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }

function Write-BrokenShim([string]$Path) {
  $content = "@echo off`n`"C:\Users\anon\软件一开发\tools\node.exe`" `"C:\Users\anon\软件一开发\tools\pnpm.cjs`" %*`n"
  [System.IO.File]::WriteAllText($Path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Start-DshHost([string]$Cli, [int]$ListenPort, [string]$OutLog, [string]$ErrLog) {
  $arguments = '/d', '/c', "`"$Cli`" --profile wintest --no-open --port $ListenPort"
  return Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog -PassThru -WindowStyle Hidden
}

function Stop-DshHost($Process) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  taskkill /PID $Process.Id /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 400
}

function Wait-ForRepair([string]$Shim, [int]$TimeoutSeconds = 25) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Shim) {
      $text = Read-Shim $Shim
      if ($text -match 'chcp 65001' -and $text.Contains("`r`n")) { return $true }
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

$cli = Resolve-DshCli
$pluginRootResolved = (Resolve-Path $PluginRoot).Path
if (-not (Test-Path (Join-Path $pluginRootResolved 'package.json'))) { Stop-Fail "PluginRoot does not look like the plugin: $pluginRootResolved" }

$testHome = if ($TestHome) { $TestHome } else { Join-Path $env:TEMP ("dsh-win-compat-verify-" + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$hostProcess = $null
$previousDshHome = $env:DSH_HOME

try {
  Write-Section 'prepare isolated DSH home'
  New-Item -ItemType Directory -Force -Path $testHome | Out-Null
  $env:DSH_HOME = $testHome
  & $cli --profile wintest --from-default-profile web --dump-config *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Fail 'could not initialize the web profile copy' }
  Write-Ok "home: $testHome"

  Write-Section 'install plugin (file:)'
  $spec = 'file:' + ($pluginRootResolved -replace '\\', '/')
  & $cli plugin --profile wintest add $spec *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Fail "dsh plugin add failed ($spec)" }
  $manifest = Get-Content -Raw (Join-Path $testHome 'profiles\wintest\package.json') | ConvertFrom-Json
  if (-not ($manifest.dsh.profile.bundles -contains 'dsh-win-compat')) { Stop-Fail 'plugin was installed but not selected as a bundle' }
  Write-Ok 'installed and selected in dsh.profile.bundles'

  Write-Section '1. startup repair'
  $shim = Join-Path $testHome 'dsh-runtimes\runtime-test\runtime-commands\bin\pnpm.cmd'
  New-Item -ItemType Directory -Force -Path (Split-Path $shim) | Out-Null
  Write-BrokenShim $shim
  if ((Read-Shim $shim) -match 'chcp') { Stop-Fail 'fixture accidentally already repaired' }
  $hostProcess = Start-DshHost $cli $Port (Join-Path $testHome 'host-1.out.log') (Join-Path $testHome 'host-1.err.log')
  if (-not (Wait-ForRepair $shim 30)) { Stop-Fail 'host boot did not repair the shim (see host-1 logs)' }
  $firstText = Read-Shim $shim
  if (-not ($firstText -match '软件一开发')) { Stop-Fail 'repair damaged the Chinese path' }
  if ($firstText -match '^\uFEFF') { Stop-Fail 'repair left a UTF-8 BOM' }
  $backup = "$shim.dsh-win-compat.bak"
  if (-not (Test-Path $backup)) { Stop-Fail 'no backup of the original shim was created' }
  Write-Ok 'boot repaired the shim (chcp 65001, CRLF, Chinese path intact, backup created)'
  Stop-DshHost $hostProcess
  $hashAfterFirst = (Get-FileHash $shim -Algorithm SHA256).Hash
  $mtimeAfterFirst = (Get-Item $shim).LastWriteTimeUtc

  Write-Section '2. restart is a no-op'
  $hostProcess = Start-DshHost $cli $Port (Join-Path $testHome 'host-2.out.log') (Join-Path $testHome 'host-2.err.log')
  Start-Sleep -Seconds 8
  $hashAfterSecond = (Get-FileHash $shim -Algorithm SHA256).Hash
  $mtimeAfterSecond = (Get-Item $shim).LastWriteTimeUtc
  if ($hashAfterSecond -ne $hashAfterFirst) { Stop-Fail 'second boot rewrote an already-correct shim' }
  if ($mtimeAfterSecond -ne $mtimeAfterFirst) { Stop-Fail 'second boot touched the shim (mtime changed)' }
  Write-Ok 'second boot left the repaired shim byte- and mtime-identical'

  Write-Section '3. live regeneration is repaired again'
  Write-BrokenShim $shim
  if ((Read-Shim $shim) -match 'chcp') { Stop-Fail 'could not rewrite the shim for the regeneration step' }
  if (-not (Wait-ForRepair $shim 15)) { Stop-Fail 'watcher did not repair the regenerated shim while the host was running' }
  Write-Ok 'watcher repaired the regenerated shim without a restart'

  Write-Section 'result'
  Write-Host 'PASS: startup → detect → repair → restart → still effective → regenerate → repaired'
} finally {
  if ($hostProcess) { Stop-DshHost $hostProcess }
  if ($previousDshHome) { $env:DSH_HOME = $previousDshHome } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
  if (-not $KeepHome -and $testHome -and (Test-Path $testHome)) {
    try { Remove-Item -Recurse -Force $testHome } catch { Write-Host "warning: could not remove $testHome" -ForegroundColor Yellow }
  } elseif ($KeepHome) {
    Write-Host "kept: $testHome"
  }
}
