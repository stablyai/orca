<#
  Poll visible windows (default 500ms), recording new handles and title changes as JSONL:
    { "ts": "<iso>", "handle": <n>, "pid": <n>, "processName": "...", "title": "..." }
  Stop at -DurationSec or -StopFile so the orchestrator controls the post-relaunch soak.
  Record all process/title evidence; JS classifies unexpected consoles/canaries. See window-enum.ps1
  for why conhost heuristics cannot establish visibility.
#>
param(
  [Parameter(Mandatory = $true)][string]$BaselinePath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$StopFile = '',
  [int]$DurationSec = 600,
  [int]$PollMs = 500,
  [string]$EnumScript = ''
)

$ErrorActionPreference = 'Stop'

if (-not $EnumScript) {
  $EnumScript = Join-Path $PSScriptRoot 'window-enum.ps1'
}
. $EnumScript

# Ignore baseline handles even after title churn; wrap { windows: [...] } for PS 5.1’s single-result unwrap.
$baselineHandles = New-Object System.Collections.Generic.HashSet[long]
if (Test-Path $BaselinePath) {
  $baseline = Get-Content -Raw $BaselinePath | ConvertFrom-Json
  foreach ($w in @($baseline.windows)) {
    if ($null -ne $w -and $null -ne $w.handle) {
      [void]$baselineHandles.Add([long]$w.handle)
    }
  }
}

# Emit appear/retitle: flashing consoles can gain their canary title after a generic Terminal title.
$titleByHandle = @{}

# Truncate/create the output file up front so the reader can always open it.
[System.IO.File]::WriteAllText($OutPath, '')

$deadline = (Get-Date).AddSeconds($DurationSec)

while ((Get-Date) -lt $deadline) {
  if ($StopFile -and (Test-Path $StopFile)) { break }

  $windows = @(Get-VisibleTopLevelWindows)
  $now = (Get-Date).ToString('o')
  foreach ($w in $windows) {
    $handle = [long]$w.handle
    if ($baselineHandles.Contains($handle)) { continue }

    $title = [string]$w.title
    $prior = $null
    $isNew = -not $titleByHandle.ContainsKey($handle)
    if (-not $isNew) { $prior = $titleByHandle[$handle] }
    if ($isNew -or $prior -ne $title) {
      $titleByHandle[$handle] = $title
      $event = [pscustomobject]@{
        ts = $now
        kind = if ($isNew) { 'appear' } else { 'retitle' }
        handle = $handle
        pid = $w.pid
        processName = $w.processName
        title = $title
      }
      $line = ($event | ConvertTo-Json -Compress -Depth 3)
      # AppendAllText with an explicit newline keeps each event on its own line
      # even if the process is killed mid-write (no buffered partial records).
      [System.IO.File]::AppendAllText($OutPath, $line + "`n")
    }
  }

  Start-Sleep -Milliseconds $PollMs
}
