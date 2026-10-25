// #7742: reproduce abrupt main death and scan Windows logs for pwsh FailFast after daemon/ConPTY pipe loss.

import { execFileSync } from 'node:child_process'
import { runCommandSync } from '../win-update-e2e/powershell-runner.mjs'

// Force-kill exactly the harness main’s app.evaluate process.pid; no /T tree kill or graceful close, which test different lifecycle behavior.
// Never target scanned/image-named processes or Playwright’s possible launcher stub.
export function crashMainProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`crashMainProcess: refusing to kill invalid pid ${pid}`)
  }
  // Omit /T so detached-daemon survival remains observable.
  execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
}

// Scan machine-wide Application logs for pwsh/powershell 0xE9/pipe/FailFast signatures since sinceMs.
// Count crash providers/ids (#1000/#1001/#1026) even with null Message unless text explicitly excludes pwsh.
// Isolated runners limit unrelated false failures; unavailable query evidence must fail closed. Return events with id/provider/time/message.
export function scanPwshFailFast(sinceMs, runCommand = runCommandSync) {
  // Use Unix milliseconds minus 5s skew allowance, avoiding locale date parsing.
  const startMs = Math.max(0, Math.floor(sinceMs) - 5000)
  const command = [
    `$start = [System.DateTimeOffset]::FromUnixTimeMilliseconds(${startMs}).LocalDateTime`,
    `$crashProviders = @('Application Error','Windows Error Reporting','.NET Runtime')`,
    `$crashIds = @(1000,1001,1026)`,
    `$sig = '0xe9|other end of the pipe|FailFast|0xc0000409|Faulting application name: pwsh|Faulting application name: powershell'`,
    // Wrap in @() so PS 5.1 serializes one match as an array.
    `try {`,
    `  $sourceEvents = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=$start } -ErrorAction Stop)`,
    `} catch {`,
    // Treat empty-window query errors as zero events; permissions/service/query failures must fail.
    `  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $sourceEvents = @() } else { throw }`,
    `}`,
    `$events = @($sourceEvents |`,
    `  Where-Object {`,
    // Count pwsh or null-message crash reporters, then explicit signature text.
    `    (($crashProviders -contains $_.ProviderName) -and ($crashIds -contains $_.Id) -and`,
    `      ((-not $_.Message) -or ($_.Message -match 'pwsh|powershell'))) -or`,
    `    ($_.Message -and ($_.Message -match 'pwsh|powershell') -and ($_.Message -match $sig)) })`,
    `$out = @($events | ForEach-Object {`,
    `  $msg = if ($_.Message) { $_.Message.Substring(0, [Math]::Min(400, $_.Message.Length)) } else { '' }`,
    `  [pscustomobject]@{ id = $_.Id; provider = $_.ProviderName; timeCreated = $_.TimeCreated.ToString('o'); message = $msg } })`,
    `ConvertTo-Json -InputObject @{ events = $out } -Depth 4 -Compress`
  ].join('\n')

  const { stdout, stderr, code, error } = runCommand(command)
  if (error) {
    throw new Error(`pwsh-failfast scan spawn failed: ${error.message}`)
  }
  // Unavailable event logs cannot prove no FailFast.
  if (code !== 0) {
    throw new Error(`pwsh-failfast scan failed (exit ${code}): ${stderr.trim()}`)
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    // Require the serialized envelope even for zero matches; empty stdout is missing evidence.
    throw new Error('pwsh-failfast scan returned no JSON output')
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (parseError) {
    throw new Error(
      `pwsh-failfast scan returned non-JSON (exit ${code}): ${parseError.message}\n` +
        `stdout:\n${trimmed}\nstderr:\n${stderr}`
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, 'events') ||
    parsed.events == null
  ) {
    // Reject malformed JSON instead of treating it as authoritative zero events.
    throw new Error('pwsh-failfast scan returned JSON without an events envelope')
  }
  const raw = parsed.events
  if (!Array.isArray(raw) && typeof raw !== 'object') {
    throw new Error('pwsh-failfast scan returned an invalid events envelope')
  }
  const events = Array.isArray(raw) ? raw : raw ? [raw] : []
  return { events }
}
