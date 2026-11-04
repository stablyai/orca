// Run Win32 probes through guaranteed Windows PowerShell 5.1, whose JSON/single-item quirks the scripts handle.

import { spawn, spawnSync } from 'node:child_process'

const POWERSHELL = 'powershell.exe'
const BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
// Bound synchronous probes so a wedged PowerShell cannot consume the full CI job timeout; opts.timeout can override.
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

// Parse one JSON stdout document; attach raw stderr/stdout on failure so PowerShell errors are not hidden by SyntaxError.
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

// Return a background PowerShell child for caller-owned tracking/stop, used by window watch.
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
