// Identify and inspect the Orca terminal daemon on Windows.
//
// The daemon is forked with ELECTRON_RUN_AS_NODE=1, so on Windows its process
// image is Orca.exe (the Electron binary running as plain Node) — it CANNOT be
// matched by executable name. The only reliable discriminators are the
// command-line markers the fork always passes: the daemon entry script
// (daemon-entry.js) and its --socket / --token arguments. See
// src/main/daemon/daemon-init.ts (createOutOfProcessLauncher).
//
// The daemon also writes a PID file at <userData>/daemon/daemon-v<N>.pid whose
// JSON carries { pid, startedAtMs, entryPath, appVersion } — the appVersion
// field lets the harness prove whether a post-update daemon was re-forked by
// the new build (cold-restore) or is the same process (survival).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { assertWin32 } from './platform-guard.mjs'
import { runCommandSync } from './powershell-runner.mjs'

const DAEMON_ENTRY_MARKER = 'daemon-entry.js'

/** Default packaged userData root on Windows: %APPDATA%\Orca. */
export function defaultUserDataDir() {
  const appData =
    process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  return path.join(appData, 'Orca')
}

/**
 * Find live daemon processes by scanning Win32_Process command lines for the
 * daemon-entry.js marker. Returns [{ pid, ppid, name, commandLine }].
 *
 * A developer box (and a busy CI runner) can host many unrelated daemons — one
 * per worktree/profile, plus lingering hosts from reverted builds. Pass
 * `scope` (a substring of the harness's own userData/token/socket path) to
 * match ONLY the daemon this harness's app instance owns. Omit it for a
 * machine-wide listing.
 */
export function findDaemonProcesses(scope = '') {
  assertWin32('daemon-processes')
  // Match by command-line marker only, never by exe name: with
  // ELECTRON_RUN_AS_NODE the daemon's image is Orca.exe today but a relocated
  // Phase 1 host may run from a differently-named copied binary. @() around the
  // filtered result guards the PS 5.1 single-item unwrap — one match must still
  // serialize as an array or the JS side sees an object and .length explodes.
  // This exact class caused a production incident.
  const command = [
    `$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |`,
    `  Where-Object { $_.CommandLine -and $_.CommandLine -match 'daemon-entry\\.js' })`,
    `$out = @($procs | ForEach-Object {`,
    `  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine } })`,
    `ConvertTo-Json -InputObject @{ processes = $out } -Depth 4 -Compress`
  ].join('\n')

  const parsed = runJsonCommand(command)
  const scopeNeedle = scope.toLowerCase()
  return normalizeArray(parsed.processes).filter(
    (p) =>
      typeof p.commandLine === 'string' &&
      p.commandLine.includes(DAEMON_ENTRY_MARKER) &&
      (scopeNeedle === '' || p.commandLine.toLowerCase().includes(scopeNeedle))
  )
}

/**
 * Read all daemon PID files under <userData>/daemon (daemon-v*.pid). Globbing
 * the protocol-versioned name keeps this correct across PROTOCOL_VERSION bumps.
 * Returns [{ file, pid, startedAtMs, entryPath, appVersion }].
 */
export function readDaemonPidFiles(userDataDir = defaultUserDataDir()) {
  const daemonDir = path.join(userDataDir, 'daemon')
  if (!existsSync(daemonDir)) {
    return []
  }
  const records = []
  for (const entry of readdirSync(daemonDir)) {
    if (!entry.startsWith('daemon-v') || !entry.endsWith('.pid')) {
      continue
    }
    const filePath = path.join(daemonDir, entry)
    // Read once: a PID file can vanish between readdir and here, and re-reading
    // it in the catch path would crash discovery on a single stale file.
    let raw = ''
    try {
      raw = readFileSync(filePath, 'utf8').trim()
      const parsed = JSON.parse(raw)
      records.push({ file: filePath, ...parsed })
    } catch {
      // Legacy/partial pid files may hold a bare integer.
      const pid = Number(raw)
      if (Number.isInteger(pid)) {
        records.push({ file: filePath, pid })
      }
    }
  }
  return records
}

/** True if a PID currently maps to a live process. */
export function isPidAlive(pid, runCommand = runCommandSync) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  const { stdout, stderr, code, error } = runCommand(
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`
  )
  if (error) {
    throw new Error(`PID liveness probe failed to spawn: ${error.message}`)
  }
  if (code !== 0) {
    throw new Error(`PID liveness probe failed (exit ${code}): ${stderr.trim()}`)
  }
  const state = stdout.trim()
  if (state !== 'alive' && state !== 'dead') {
    // Why: blank or unexpected output is unavailable evidence, not proof that
    // a process died; crash-survival assertions must fail closed.
    throw new Error(`PID liveness probe returned an invalid state: ${JSON.stringify(state)}`)
  }
  return state === 'alive'
}

function runJsonCommand(command) {
  const { stdout, stderr, code, error } = runCommandSync(command)
  if (error) {
    throw new Error(`PowerShell spawn failed: ${error.message}`)
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    // No matches: ConvertTo-Json of an empty array can emit nothing.
    return { processes: [] }
  }
  try {
    return JSON.parse(trimmed)
  } catch (parseError) {
    throw new Error(
      `daemon-processes query returned non-JSON (exit ${code}): ${parseError.message}\n` +
        `stdout:\n${trimmed}\nstderr:\n${stderr}`
    )
  }
}

function normalizeArray(raw) {
  if (!raw) {
    return []
  }
  return Array.isArray(raw) ? raw : [raw]
}

function parseUserDataArg(argv) {
  const idx = argv.indexOf('--user-data')
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : defaultUserDataDir()
}

function runStandalone(argv) {
  assertWin32('daemon-processes standalone')
  const userDataDir = parseUserDataArg(argv)
  console.log(`[daemon-processes] userData: ${userDataDir}`)

  const pidFiles = readDaemonPidFiles(userDataDir)
  console.log(`[daemon-processes] PID files (${pidFiles.length}):`)
  console.log(JSON.stringify(pidFiles, null, 2))

  const scopeIdx = argv.indexOf('--scope')
  const scope = scopeIdx >= 0 && argv[scopeIdx + 1] ? argv[scopeIdx + 1] : ''
  const processes = findDaemonProcesses(scope)
  console.log(
    `[daemon-processes] live daemon processes${scope ? ` scoped to "${scope}"` : ''} (${processes.length}):`
  )
  console.log(JSON.stringify(processes, null, 2))

  for (const rec of pidFiles) {
    if (typeof rec.pid === 'number') {
      console.log(`[daemon-processes] pid ${rec.pid} alive: ${isPidAlive(rec.pid)}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    runStandalone(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
