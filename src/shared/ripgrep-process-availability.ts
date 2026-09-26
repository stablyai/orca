import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'

const RIPGREP_CWD_CHECK_TIMEOUT_MS = 1000
const RIPGREP_FAILURE_PROBE_TIMEOUT_MS = 5000

export class RipgrepUnavailableError extends Error {
  constructor() {
    super('ripgrep is unavailable')
    this.name = 'RipgrepUnavailableError'
  }
}

/** rg could not be launched even though ripgrep itself is installed; retryable, never install guidance. */
export class RipgrepLaunchFailureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RipgrepLaunchFailureError'
  }
}

// Why: fork/exec pressure (out of processes, fds, or memory) is not evidence that ripgrep is missing.
const TRANSIENT_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'ETXTBSY'
])

export function isTransientRipgrepSpawnError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && TRANSIENT_SPAWN_ERROR_CODES.has(code)
}

function ignoreRipgrepSpawnError(): void {}

export function killSpawnedRipgrepProcess(child: ChildProcess): boolean {
  // Why: killing a failed-spawn handle can signal the relay's own process group.
  if (Object.hasOwn(child, 'pid') && child.pid === undefined) {
    return false
  }
  return child.kill()
}

export function absorbPendingRipgrepSpawnError(
  child: ChildProcess,
  state: { errorObserved: boolean; unavailableExitObserved: boolean }
): void {
  if (
    state.errorObserved ||
    (!state.unavailableExitObserved && !(Object.hasOwn(child, 'pid') && child.pid === undefined))
  ) {
    return
  }
  // Why: concurrent-pass cleanup can win before Node delivers the queued spawn error.
  child.once('error', ignoreRipgrepSpawnError)
}

export async function isRipgrepSpawnCwdUsable(cwd: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), RIPGREP_CWD_CHECK_TIMEOUT_MS)
    timeout.unref?.()
  })
  const checked = Promise.all([stat(cwd), access(cwd, constants.X_OK)]).then(
    ([entry]) => entry.isDirectory(),
    () => false
  )
  try {
    return await Promise.race([checked, timedOut])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function probeRipgrepVersion(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // windowsHide: a probe must never flash a console window on Windows.
      child = spawn(command, ['--version'], { env, stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    // Why kill on timeout: a `rg --version` that hangs -- a stalled network mount, or antivirus
    // holding a just-installed rg.exe -- would otherwise leave a live process and a ref'd handle
    // behind for the relay's lifetime, once per launch failure.
    const settle = (available: boolean, kill = false): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.off('close', onClose)
      if (kill) {
        killSpawnedRipgrepProcess(child)
      }
      // Why leave one 'error' listener attached: a spawn error can still arrive after this
      // settles, and an unhandled 'error' on a ChildProcess throws.
      child.once('error', ignoreRipgrepSpawnError)
      resolve(available)
    }
    const onClose = (code: number | null): void => settle(code === 0)
    child.once('error', () => settle(false))
    child.once('close', onClose)
    const timeout = setTimeout(() => settle(false, true), RIPGREP_FAILURE_PROBE_TIMEOUT_MS)
    timeout.unref?.()
  })
}

/**
 * Why a launch failure needs classifying: spawn reports an unreachable cwd as ENOENT, the same as
 * a missing binary. Telling a user to install ripgrep because their workspace moved sends them
 * down the wrong path, and resolving an empty result hides the move entirely.
 *
 * `candidates` are the ripgreps worth asking about, in order -- the command that actually failed
 * first, then the host's PATH one. Probing only PATH would misclassify the normal remote setup,
 * where Orca uploaded a bundled binary precisely because the host has no `rg` of its own: the
 * probe would fail and a moved workspace would be reported as a missing ripgrep. Nulls are
 * skipped, and a host with no working ripgrep at all keeps 'ripgrep-unavailable', because only
 * that verdict engages the git/readdir fallback chain.
 */
export async function classifyRipgrepLaunchFailure(
  cwd: string,
  candidates: readonly (string | null)[],
  env: NodeJS.ProcessEnv
): Promise<'cwd-unreachable' | 'ripgrep-unavailable'> {
  if (await isRipgrepSpawnCwdUsable(cwd)) {
    return 'ripgrep-unavailable'
  }
  for (const command of new Set(candidates.filter((entry) => entry !== null))) {
    if (await probeRipgrepVersion(command, env)) {
      return 'cwd-unreachable'
    }
  }
  return 'ripgrep-unavailable'
}

/**
 * Exit code the WSL wrapper uses when it cannot enter the search root. Why a dedicated code:
 * ripgrep exits 1 for "no matches", so without this an unreachable workspace would report an
 * empty listing as a successful scan. Picked above ripgrep's own 0/1/2 and clear of the shell's
 * 126/127 and 128+signal range.
 */
export const RIPGREP_MISSING_CWD_EXIT_CODE = 97

export function isRipgrepMissingCwdExit(code: number | null): boolean {
  return code === RIPGREP_MISSING_CWD_EXIT_CODE
}

export function ripgrepMissingCwdError(cwd: string): Error {
  return new Error(`Search root is not reachable: ${cwd}`)
}

// ENOTDIR and some resource failures throw before a ChildProcess can emit an error.
export async function classifySynchronousRipgrepSpawnFailure(
  error: unknown,
  cwd: string
): Promise<Error> {
  // Why pass an already-classified error straight through: this only diagnoses raw spawn errnos.
  // A caller that threw a verdict of its own has more context than a cwd probe does.
  if (error instanceof RipgrepUnavailableError || error instanceof RipgrepLaunchFailureError) {
    return error
  }
  if (isTransientRipgrepSpawnError(error)) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
    return new RipgrepLaunchFailureError(`rg failed to start (${code})`)
  }
  if (!(await isRipgrepSpawnCwdUsable(cwd))) {
    return ripgrepMissingCwdError(cwd)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function isRipgrepUnavailableExit(
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
  options: { classifyNativeLauncherExit?: boolean } = {}
): boolean {
  if (signal) {
    return false
  }
  if ((Object.hasOwn(child, 'pid') && child.pid === undefined) || (code !== null && code < 0)) {
    return true
  }
  return Boolean(options.classifyNativeLauncherExit && code !== null && code > 2)
}
