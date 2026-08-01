<#
  window-watch.ps1 — poll visible top-level windows and record every NEW one.

  Runs a tight loop (default 500ms) that diffs the current visible top-level
  windows against a baseline snapshot, appending any window handle it has not
  seen before to a JSONL file as one event per line:
    { "ts": "<iso>", "handle": <n>, "pid": <n>, "processName": "...", "title": "..." }

  It stops when -DurationSec elapses or -StopFile appears (whichever comes
  first), so the orchestrator can end the watch deterministically after the
  post-relaunch soak window.

  Attribution is by owner process + title only (see window-enum.ps1 for why
  conhost heuristics are invalid). Classification of which new windows count as
  "unexpected" (canary title, terminal/console owner) is done by the JS
  assertions layer against this raw event log — this probe records everything.
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

# Seed the baseline handle set so pre-existing windows never register. Their
# later title churn (clocks, tab names) is irrelevant noise, so baseline
# handles are excluded outright. Baseline JSON is { windows: [ { handle, ... } ] };
# tolerate the PS 5.1 single-element unwrap by wrapping with @().
$baselineHandles = New-Object System.Collections.Generic.HashSet[long]
if (Test-Path $BaselinePath) {
  $baseline = Get-Content -Raw $BaselinePath | ConvertFrom-Json
  foreach ($w in @($baseline.windows)) {
    if ($null -ne $w -and $null -ne $w.handle) {
      [void]$baselineHandles.Add([long]$w.handle)
    }
  }
}

# Track the last-seen title of each NEW window. A window is emitted on first
# sighting ("appear") and again whenever its title changes ("retitle"): a real
# flashing console often opens with a generic title (e.g. WindowsTerminal's
# "Terminal") and only later shows our child's canary title, so title evolution
# must be captured or canary attribution is missed.
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
