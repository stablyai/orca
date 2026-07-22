// The abrupt main-process crash + its Windows event-log forensics.
//
// GitHub #7742: when Orca's main/renderer process died on Windows, the terminal
// daemon (which hosts the ConPTYs) died with it, severing the console pipe, and
// PowerShell hard-crashed with a 0xE9 "No process is on the other end of the
// pipe" FailFast. The fix relocates the daemon into a standalone, detached
// orca-terminal-daemon.exe that SURVIVES main death (src/main/daemon/
// daemon-host-relocation.ts). This module reproduces the crash and scans for the
// pwsh FailFast that must no longer occur.

import { execFileSync } from 'node:child_process'
import { runCommandSync } from '../win-update-e2e/powershell-runner.mjs'

/**
 * Abruptly crash ONLY the app main process. `/F` (force) with NO `/T` (tree) is
 * the single load-bearing detail: a real main crash does not tree-kill the
 * detached daemon, so tree-killing here — or closing gracefully — would leave the
 * daemon alive for the wrong reason and make the survival assertion pass
 * vacuously. Kills exactly `pid` (the real Electron main of the instance the
 * harness launched, resolved via app.evaluate -> process.pid), never a scanned
 * or image-named process, so a live user Orca on the same box is never touched.
 */
export function crashMainProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`crashMainProcess: refusing to kill invalid pid ${pid}`)
  }
  // NO '/T': tree-killing would take the detached daemon down with the main and
  // defeat the entire point of the test.
  execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
}

/**
 * Scan the Windows Application event log for pwsh/powershell FailFast crashes in
 * the crash window (from `sinceMs`). The #7742 signature is a 0xE9 exit / "No
 * process is on the other end of the pipe" / FailFast (0xc0000409 stack-overrun),
 * reported as an Application Error (#1000), Windows Error Reporting (#1001), or
 * .NET Runtime (#1026) event for pwsh.exe. Matching by provider+id (not Message
 * text alone) matters because Message can be null when the provider's resource
 * DLL does not render — a null-Message crash from those reporters is still counted
 * unless its text positively rules out pwsh, so we never miss a real FailFast.
 *
 * The scan is MACHINE-WIDE (Get-WinEvent has no per-process filter): on an
 * isolated CI runner nothing else crashes in the ~10s window, so it can only ever
 * false-FAIL (an unrelated crash), never false-PASS. Zero events is the decisive
 * proof the ConPTY pipe was NOT severed. Returns
 * { events: [{ id, provider, timeCreated, message }] }.
 */
export function scanPwshFailFast(sinceMs, runCommand = runCommandSync) {
  // Build the start boundary from Unix ms directly (no locale-dependent string
  // parse) and back it off 5s for clock skew between Node's Date.now() and the
  // event-log timestamps.
  const startMs = Math.max(0, Math.floor(sinceMs) - 5000)
  const command = [
    `$start = [System.DateTimeOffset]::FromUnixTimeMilliseconds(${startMs}).LocalDateTime`,
    `$crashProviders = @('Application Error','Windows Error Reporting','.NET Runtime')`,
    `$crashIds = @(1000,1001,1026)`,
    `$sig = '0xe9|other end of the pipe|FailFast|0xc0000409|Faulting application name: pwsh|Faulting application name: powershell'`,
    // @() guards the PS 5.1 single-item unwrap: one match must still serialize as
    // an array, or the JS side sees an object and .length explodes.
    `try {`,
    `  $sourceEvents = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=$start } -ErrorAction Stop)`,
    `} catch {`,
    // Get-WinEvent reports an empty window as an error; that is valid zero-event
    // evidence, while permissions/service/query failures must still fail closed.
    `  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $sourceEvents = @() } else { throw }`,
    `}`,
    `$events = @($sourceEvents |`,
    `  Where-Object {`,
    // A crash-reporter event referencing pwsh/powershell (or whose Message failed
    // to render at all) counts; otherwise fall back to explicit signature text.
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
  // Why: unavailable event-log evidence cannot count as proof that no FailFast
  // occurred; fail the harness instead of converting an empty error into zero.
  if (code !== 0) {
    throw new Error(`pwsh-failfast scan failed (exit ${code}): ${stderr.trim()}`)
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    // Why: the script always serializes an events envelope, including for zero
    // matches; empty stdout means the load-bearing evidence never arrived.
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
    // Why: only the explicit envelope proves the query completed; malformed
    // JSON must not be indistinguishable from an authoritative zero-event result.
    throw new Error('pwsh-failfast scan returned JSON without an events envelope')
  }
  const raw = parsed.events
  if (!Array.isArray(raw) && typeof raw !== 'object') {
    throw new Error('pwsh-failfast scan returned an invalid events envelope')
  }
  const events = Array.isArray(raw) ? raw : raw ? [raw] : []
  return { events }
}
