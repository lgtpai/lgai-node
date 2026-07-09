# LGAI Node installer — Windows 10/11 (PowerShell)
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Coordinator URL] [-Name NAME] [-Service]
#   -Service : auto-start at logon via Scheduled Task
param(
  [string]$Coordinator = "http://127.0.0.1:18402",
  [string]$Name = $env:COMPUTERNAME,
  [switch]$Service
)
$ErrorActionPreference = "Stop"
function Say($m){ Write-Host "[OK] $m" -ForegroundColor Green }
function Fail($m){ Write-Host "[X] $m" -ForegroundColor Red; exit 1 }

# ---- 1. Node.js >= 18 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js not found. Install Node 18+ :  winget install OpenJS.NodeJS.LTS   (or https://nodejs.org)" }
$ver = [int]((node -v) -replace '^v','' -split '\.')[0]
if ($ver -lt 18) { Fail "Node.js >= 18 required (found $(node -v))" }
Say "Node.js $(node -v)"

# ---- 2. copy files ----
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path "$src\client\lgai-node.js")) { $src = Split-Path -Parent $src }
if (-not (Test-Path "$src\client\lgai-node.js")) { Fail "cannot locate package files next to install.ps1" }
$dest = "$env:LOCALAPPDATA\LGAI\node"
New-Item -ItemType Directory -Force -Path $dest, "$dest\logs" | Out-Null
Copy-Item -Recurse -Force "$src\client", "$src\coordinator" $dest
foreach($f in @("package.json","README.md","README.zh-CN.md")){ if(Test-Path "$src\$f"){ Copy-Item -Force "$src\$f" $dest } }
Say "installed to $dest"

# ---- 3. launchers + PATH ----
@"
@echo off
node "%~dp0client\lgai-node.js" %*
"@ | Set-Content -Encoding ASCII "$dest\lgai-node.cmd"
@"
@echo off
node "%~dp0coordinator\server.js" %*
"@ | Set-Content -Encoding ASCII "$dest\lgai-coordinator.cmd"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dest", "User")
  Say "added to user PATH (restart the terminal to take effect)"
}
Say "launchers: lgai-node.cmd, lgai-coordinator.cmd"

# ---- 4. optional service (Scheduled Task at logon) ----
if ($Service) {
  $action  = New-ScheduledTaskAction -Execute (Get-Command node).Source `
             -Argument "`"$dest\client\lgai-node.js`" --coordinator $Coordinator --name $Name" `
             -WorkingDirectory $dest
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName "LGAI Node" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName "LGAI Node"
  Say "scheduled task 'LGAI Node' registered and started"
}

Write-Host ""
Say "done. try it (new terminal):"
Write-Host "    lgai-node --coordinator $Coordinator --name $Name"
Write-Host "    lgai-node --mock            # offline test"
Write-Host "    lgai-coordinator            # run your own coordinator (dashboard :18402)"
