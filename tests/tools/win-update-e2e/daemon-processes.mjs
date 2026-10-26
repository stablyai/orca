// Identify run-as-node daemons by daemon-entry.js/--socket/--token, never Orca.exe image name.
// Versioned PID files carry startedAtMs/entryPath/appVersion for cold-restore versus same-process survival evidence.

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

// Scan command-line daemon markers; scope to this harness’s userData/token/socket substring to exclude unrelated profiles.
// Omitting scope intentionally lists machine-wide daemons.
export function findDaemonProcesses(scope = '') {
  assertWin32('daemon-processes')
  // Match entry marker across copied exe names; @() prevents PS 5.1 single-match object unwrapping, a prior production incident.
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

// Read daemon-v*.pid across protocol bumps; return file/pid/start/entry/version metadata.
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
    // Read once: PID files can disappear during discovery, including catch paths.
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
    // Treat blank/unexpected process evidence as unavailable, not proof of death.
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
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : defaultUserDataDir()
}

function runStandalone(argv) {
  assertWin32('daemon-processes standalone')
  const userDataDir = parseUserDataArg(argv)
  console.log(`[daemon-processes] userData: ${userDataDir}`)

  const pidFiles = readDaemonPidFiles(userDataDir)
  console.log(`[daemon-processes] PID files (${pidFiles.length}):`)
  console.log(JSON.stringify(pidFiles, null, 2))

  const scopeIdx = argv.indexOf('--scope')
  const scope = scopeIdx !== -1 && argv[scopeIdx + 1] ? argv[scopeIdx + 1] : ''
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
