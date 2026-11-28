# Runs an installer with a Basic User token (runas /trustlevel:0x20000: no Administrators group, no
# SeDebugPrivilege), as a normal per-user install runs, and waits for it. Prints JSON {pid, exit}.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '',
  [int]$TimeoutSec = 300
)
$full = (Resolve-Path -LiteralPath $Exe).Path
if ($full.Contains(' ')) { throw "runas needs a path without spaces: $full" }
& runas.exe /trustlevel:0x20000 "$full $Arguments" | Out-Null
$proc = $null
$deadline = (Get-Date).AddSeconds(30)
while (-not $proc -and (Get-Date) -lt $deadline) {
  $match = Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -eq $full } | Select-Object -First 1
  if ($match) {
    $proc = Get-Process -Id $match.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { [void]$proc.Handle }
  } else {
    Start-Sleep -Milliseconds 100
  }
}
if (-not $proc) {
  [pscustomobject]@{ pid = $null; exit = 'not started' } | ConvertTo-Json -Compress
  exit 0
}
$done = $proc.WaitForExit($TimeoutSec * 1000)
[pscustomobject]@{ pid = $proc.Id; exit = if ($done) { $proc.ExitCode } else { 'timeout' } } | ConvertTo-Json -Compress
