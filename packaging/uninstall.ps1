# LGAI Node uninstaller — Windows
$ErrorActionPreference = "SilentlyContinue"
Unregister-ScheduledTask -TaskName "LGAI Node" -Confirm:$false
$dest = "$env:LOCALAPPDATA\LGAI\node"
Remove-Item -Recurse -Force $dest
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", ($userPath -replace [regex]::Escape(";$dest"), ""), "User")
Write-Host "removed $dest (node credentials in ~\.lgai kept; delete manually if needed)"
