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

function checkRipgrepAvailableWithoutCwd(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn('rg', ['--version'], { stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    let errorObserved = false
    let unavailableExitObserved = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const settle = (available: boolean, kill = false): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      child.off('error', onError)
      child.off('close', onClose)
      if (kill) {
        child.once('error', ignoreRipgrepSpawnError)
        killSpawnedRipgrepProcess(child)
      } else {
        absorbPendingRipgrepSpawnError(child, { errorObserved, unavailableExitObserved })
      }
      resolve(available)
    }
    const onError = (): void => {
      errorObserved = true
      settle(false)
    }
    const onClose = (code: number | null): void => {
      unavailableExitObserved = code !== null && code < 0
      settle(code === 0)
    }
    child.once('error', onError)
    child.once('close', onClose)
    timeout = setTimeout(() => settle(false, true), RIPGREP_FAILURE_PROBE_TIMEOUT_MS)
    timeout.unref?.()
  })
}

export async function isRipgrepUnavailableAfterLaunchFailure(cwd: string): Promise<boolean> {
  if (await isRipgrepSpawnCwdUsable(cwd)) {
    return true
  }
  return !(await checkRipgrepAvailableWithoutCwd())
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
