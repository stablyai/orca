import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'

const RIPGREP_CWD_CHECK_TIMEOUT_MS = 1000

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

export function killSpawnedRipgrepProcess(child: ChildProcessHandle): boolean {
  // Why: killing a failed-spawn handle can signal the relay's own process group.
  if (Object.hasOwn(child, 'pid') && child.pid === undefined) {
    return false
  }
  return child.kill()
}

export function absorbPendingRipgrepSpawnError(
  child: ChildProcessHandle,
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

/** WSL cwd failures must differ from rg’s “no matches” (1); 97 also avoids shell error/signal ranges. */
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
  // Preserve caller diagnoses; cwd probing only interprets raw spawn errnos.
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
  child: ChildProcessHandle,
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
