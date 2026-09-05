import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { runProcessSync } from './child-process/run-process'

/**
 * Resolves a PowerShell host that can actually run Orca's helper scripts.
 *
 * Why not the hardcoded System32 path: managed Windows fleets ship with Windows
 * PowerShell 5.1 disabled and PowerShell 7 installed alongside it. There, the
 * 5.1 host still exists and still exits 0 — it just stops partway through the
 * script — so a path check or an exit-code check both report a working host and
 * every dependent feature fails with an unrelated error downstream.
 */

const PROBE_TIMEOUT_MS = 5_000
const PROBE_EXIT_CODE = 7
const PROBE_MARKER = 'orca-powershell-host-ok'
const NEGATIVE_CACHE_TTL_MS = 30_000

export type WindowsPowerShellHostProbe = (executablePath: string) => boolean

type HostCache = { host: string } | { host: null; cachedAt: number }

let hostCache: HostCache | null = null

function getSystem32PowerShell(env: NodeJS.ProcessEnv): string {
  return win32.join(
    env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function getPathPwshCandidates(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((directory) => join(directory, 'pwsh.exe'))
}

/**
 * Ordered by preference: Windows PowerShell 5.1 first, because every existing
 * Orca script was written and tested against it, then PowerShell 7 wherever it
 * installs. The Store build's real path carries its version
 * (WindowsApps\Microsoft.PowerShell_7.6.5.0_x64__…), so only its stable
 * execution alias and PATH entry are worth naming.
 */
export function getWindowsPowerShellHostCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    getSystem32PowerShell(env),
    win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...(env.LOCALAPPDATA
      ? [win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')]
      : []),
    ...getPathPwshCandidates(env)
  ]
  return [...new Set(candidates)]
}

/**
 * Runs the same shape Orca depends on — an `-EncodedCommand` payload that writes
 * a file and then exits with a known code — and requires both halves. A host
 * that returns the exit code without producing the file is exactly the failure
 * this probe exists to catch.
 */
export function probeWindowsPowerShellHost(executablePath: string): boolean {
  if (!existsSync(executablePath)) {
    return false
  }
  const markerPath = join(tmpdir(), `orca-powershell-probe-${randomUUID()}.txt`)
  const script = `[IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', '${PROBE_MARKER}'); exit ${PROBE_EXIT_CODE}`
  try {
    const result = runProcessSync({
      program: executablePath,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.code !== PROBE_EXIT_CODE) {
      return false
    }
    return readFileSync(markerPath, 'utf-8').trim() === PROBE_MARKER
  } catch {
    return false
  } finally {
    rmSync(markerPath, { force: true })
  }
}

/**
 * The probe costs a process launch, so the answer is cached for the session. A
 * fallback answer expires: PowerShell 7 can be installed while Orca is running.
 *
 * Why fall back to Windows PowerShell instead of reporting nothing: a probe can
 * fail for reasons that have nothing to do with the host (no temp dir, a
 * scanner holding the marker file). Returning the historical path keeps those
 * environments exactly as they were, and callers that need proof the script ran
 * have it in the PID relay.
 */
export function resolveWindowsPowerShellHost(
  probe: WindowsPowerShellHostProbe = probeWindowsPowerShellHost,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (hostCache) {
    if (hostCache.host !== null) {
      return hostCache.host
    }
    if (Date.now() - hostCache.cachedAt < NEGATIVE_CACHE_TTL_MS) {
      return getSystem32PowerShell(env)
    }
  }
  for (const candidate of getWindowsPowerShellHostCandidates(env)) {
    if (probe(candidate)) {
      hostCache = { host: candidate }
      return candidate
    }
  }
  hostCache = { host: null, cachedAt: Date.now() }
  return getSystem32PowerShell(env)
}

export function resetWindowsPowerShellHostCacheForTests(): void {
  hostCache = null
}
