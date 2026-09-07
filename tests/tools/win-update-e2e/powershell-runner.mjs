// Thin wrapper around Windows PowerShell 5.1 for the harness's Win32 probes.
//
// Everything that inspects windows or processes goes through Windows PowerShell
// (powershell.exe) rather than pwsh, because 5.1 is guaranteed present on every
// Windows box and the .ps1 probes are written for its quirks (notably the
// single-item .Count pitfall — see window-enum.ps1 / daemon-processes.mjs).

import { spawn, spawnSync } from 'node:child_process'

const POWERSHELL = 'powershell.exe'
const BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
// Cap sync probes so a wedged PowerShell call can't block the harness until the
// whole CI job times out. Callers can override via opts.timeout.
const DEFAULT_SYNC_TIMEOUT_MS = 60_000

/** Quote a value as a PowerShell single-quoted literal. */
export function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Run a .ps1 file synchronously and return { code, stdout, stderr }.
 * scriptArgs is an array of string arguments passed after -File.
 */
export function runScriptFileSync(scriptPath, scriptArgs = [], opts = {}) {
  const result = spawnSync(POWERSHELL, [...BASE_ARGS, '-File', scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: DEFAULT_SYNC_TIMEOUT_MS,
    ...opts
  })
  return {
    code: result.status ?? (result.error ? -1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null
  }
}

/**
 * Run a .ps1 file whose stdout is a single JSON document and return the parsed
 * value. Throws with the raw stderr/stdout attached when parsing fails, so a
 * malformed probe surfaces its actual PowerShell error instead of a bare
 * SyntaxError.
 */
export function runScriptFileJson(scriptPath, scriptArgs = [], opts = {}) {
  const { code, stdout, stderr, error } = runScriptFileSync(scriptPath, scriptArgs, opts)
  if (error) {
    throw new Error(`Failed to spawn PowerShell for ${scriptPath}: ${error.message}`)
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error(
      `PowerShell script ${scriptPath} produced no stdout (exit ${code}). stderr:\n${stderr}`
    )
  }
  try {
    return JSON.parse(trimmed)
  } catch (parseError) {
    throw new Error(
      `PowerShell script ${scriptPath} did not emit valid JSON (exit ${code}): ` +
        `${parseError.message}\n--- stdout ---\n${trimmed}\n--- stderr ---\n${stderr}`
    )
  }
}

/**
 * Spawn a .ps1 file as a long-running background child. Returns the ChildProcess
 * so the caller can track/stop it. Used for the window watch loop.
 */
export function spawnScriptFile(scriptPath, scriptArgs = [], opts = {}) {
  return spawn(POWERSHELL, [...BASE_ARGS, '-File', scriptPath, ...scriptArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
}

/** Run an inline command string synchronously and return { code, stdout, stderr }. */
export function runCommandSync(command, opts = {}) {
  const result = spawnSync(POWERSHELL, [...BASE_ARGS, '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: DEFAULT_SYNC_TIMEOUT_MS,
    ...opts
  })
  return {
    code: result.status ?? (result.error ? -1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null
  }
}
