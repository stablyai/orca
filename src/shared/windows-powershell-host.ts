import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { runProcess } from './child-process/run-process'

/**
 * Resolves a PowerShell host that can actually run Orca's helper scripts.
 *
 * Why not the hardcoded System32 path: managed Windows fleets ship with Windows
 * PowerShell 5.1 disabled and PowerShell 7 installed alongside it. There, the
 * 5.1 host still exists and still exits 0 — it just stops partway through the
 * script — so a path check or an exit-code check both report a working host and
 * every dependent feature fails with an unrelated error downstream.
 */

// Why 20s and not the 5s a warm shell needs: measured on a fleet laptop, the
// same pwsh that starts in ~1s from cmd.exe takes 7.9s spawned from Orca, and
// powershell.exe took 15.4s — endpoint security inspects the Electron child
// tree. A short timeout rejects every working host and lands on the fallback.
const PROBE_TIMEOUT_MS = 20_000
const PROBE_EXIT_CODE = 7
const PROBE_MARKER = 'orca-powershell-host-ok'
const FALLBACK_CACHE_TTL_MS = 30_000

export type WindowsPowerShellHostProbeResult = {
  ok: boolean
  timedOut?: boolean
  exitCode?: number | null
  markerOk?: boolean
}

export type WindowsPowerShellHostAsyncProbe = (
  executablePath: string
) => Promise<WindowsPowerShellHostProbeResult>

export type WindowsPowerShellHostAttempt = WindowsPowerShellHostProbeResult & {
  path: string
  /** Ruled out by the cheap filesystem filter, so nothing was spawned. */
  absent?: boolean
  durationMs: number
}

export type WindowsPowerShellHostResolution = {
  host: string
  /** True when no candidate passed and Windows PowerShell was used anyway. */
  fellBack: boolean
  attempts: WindowsPowerShellHostAttempt[]
}

type HostCache = { host: string } | { host: null; cachedAt: number }

let hostCache: HostCache | null = null
let resolutionObserver: ((resolution: WindowsPowerShellHostResolution) => void) | null = null
let warmupInFlight: Promise<string> | null = null

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
 * Only a definitive absence may skip the probe. An App Execution Alias — how the
 * Store build of PowerShell 7 is normally reached — is a zero-length reparse
 * point that runs fine but answers `stat` with EACCES, so treating every stat
 * failure as "missing" discards the one candidate such a machine has.
 */
export function isPossibleWindowsPowerShellHost(executablePath: string): boolean {
  try {
    statSync(executablePath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/**
 * Runs the same shape Orca depends on — an `-EncodedCommand` payload that writes
 * a file and then exits with a known code — and requires both halves. A host
 * that returns the exit code without producing the file is exactly the failure
 * this probe exists to catch.
 */
function buildProbeSpec(
  executablePath: string,
  markerPath: string
): {
  program: string
  args: string[]
  timeoutMs: number
  stdio: ['ignore', 'pipe', 'pipe']
} {
  const script = `[IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', '${PROBE_MARKER}'); exit ${PROBE_EXIT_CODE}`
  return {
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
  }
}

function readProbeMarker(markerPath: string): boolean {
  try {
    return readFileSync(markerPath, 'utf-8').trim() === PROBE_MARKER
  } catch {
    return false
  }
}

function newMarkerPath(): string {
  return join(tmpdir(), `orca-powershell-probe-${randomUUID()}.txt`)
}

export async function probeWindowsPowerShellHostAsync(
  executablePath: string
): Promise<WindowsPowerShellHostProbeResult> {
  const markerPath = newMarkerPath()
  try {
    const result = await runProcess(buildProbeSpec(executablePath, markerPath))
    const markerOk = readProbeMarker(markerPath)
    return {
      ok: result.code === PROBE_EXIT_CODE && markerOk,
      timedOut: result.timedOut,
      exitCode: result.code,
      markerOk
    }
  } catch {
    return { ok: false }
  } finally {
    rmSync(markerPath, { force: true })
  }
}

/**
 * The host to run helper scripts with, without ever spawning anything: probing
 * is the warm-up's job. A blocking probe on this path would freeze the main
 * process for as long as endpoint security takes to let PowerShell start —
 * measured at 15s on the fleet laptop that motivated this module.
 */
export function getWindowsPowerShellHost(env: NodeJS.ProcessEnv = process.env): string {
  return hostCache?.host ?? getSystem32PowerShell(env)
}

/**
 * Probes the candidates and caches the first host that runs the script. Safe to
 * call repeatedly: a resolved host short-circuits, concurrent callers share one
 * in-flight run, and a fallback is retried once its TTL expires (PowerShell 7
 * can be installed while Orca is running, and a probe that only timed out may
 * succeed on a quieter machine).
 *
 * Why fall back to Windows PowerShell instead of reporting nothing: a probe can
 * fail for reasons that have nothing to do with the host, and returning the
 * historical path keeps those environments exactly as they were. The fallback
 * is reported through the observer so it is visible rather than silent.
 */
export function warmWindowsPowerShellHostCache(
  probe: WindowsPowerShellHostAsyncProbe = probeWindowsPowerShellHostAsync,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (hostCache?.host) {
    return Promise.resolve(hostCache.host)
  }
  if (hostCache?.host === null && Date.now() - hostCache.cachedAt < FALLBACK_CACHE_TTL_MS) {
    return Promise.resolve(getSystem32PowerShell(env))
  }
  warmupInFlight ??= runWarmup(probe, env).finally(() => {
    warmupInFlight = null
  })
  return warmupInFlight
}

async function runWarmup(
  probe: WindowsPowerShellHostAsyncProbe,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const attempts: WindowsPowerShellHostAttempt[] = []
  for (const candidate of getWindowsPowerShellHostCandidates(env)) {
    if (!isPossibleWindowsPowerShellHost(candidate)) {
      attempts.push({ path: candidate, absent: true, ok: false, durationMs: 0 })
      continue
    }
    const startedAt = Date.now()
    const result = await probe(candidate)
    attempts.push({ ...result, path: candidate, durationMs: Date.now() - startedAt })
    if (result.ok) {
      hostCache = { host: candidate }
      resolutionObserver?.({ host: candidate, fellBack: false, attempts })
      return candidate
    }
  }
  hostCache = { host: null, cachedAt: Date.now() }
  const fallback = getSystem32PowerShell(env)
  resolutionObserver?.({ host: fallback, fellBack: true, attempts })
  return fallback
}

/**
 * Reports each real resolution (cache hits stay silent). Lets the main process
 * record which host was chosen without this module reaching into its logging.
 */
export function setWindowsPowerShellHostResolutionObserver(
  observer: ((resolution: WindowsPowerShellHostResolution) => void) | null
): void {
  resolutionObserver = observer
}

export function resetWindowsPowerShellHostCacheForTests(): void {
  hostCache = null
  warmupInFlight = null
  resolutionObserver = null
}
