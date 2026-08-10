// Why: remote Git can legitimately transfer large histories, while auth and
// transport helpers otherwise have no upper bound when they become stuck.
export const GIT_REMOTE_OPERATION_TIMEOUT_MS = 120_000
export const GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS = GIT_REMOTE_OPERATION_TIMEOUT_MS
export const GIT_REMOTE_OPERATION_TIMEOUT_ENV = 'ORCA_GIT_REMOTE_OPERATION_TIMEOUT_MS'
// Reserve enough of the action deadline for TERM-to-KILL cleanup and error delivery.
export const GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS = 2_500

export type GitRemoteOperationDeadline = Readonly<{
  startedAtMs: number
  timeoutMs: number
  expiresAtMs: number
}>

export type GitRemoteOperationContext = Readonly<{
  deadline: GitRemoteOperationDeadline
  signal: AbortSignal
}>

export function resolveGitRemoteOperationTimeoutMs(value?: string): number {
  if (!value) {
    return GIT_REMOTE_OPERATION_TIMEOUT_MS
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= GIT_REMOTE_OPERATION_TIMEOUT_MS
    ? parsed
    : GIT_REMOTE_OPERATION_TIMEOUT_MS
}

export function createGitRemoteOperationDeadline(
  timeoutMs = GIT_REMOTE_OPERATION_TIMEOUT_MS,
  startedAtMs = performance.now()
): GitRemoteOperationDeadline {
  return { startedAtMs, timeoutMs, expiresAtMs: startedAtMs + timeoutMs }
}

export function gitRemoteOperationRemainingMs(
  deadline: GitRemoteOperationDeadline,
  nowMs = performance.now()
): number {
  return Math.max(0, Math.ceil(deadline.expiresAtMs - nowMs))
}

export function gitRemoteOperationExecutionTimeoutMs(
  deadline: GitRemoteOperationDeadline,
  nowMs = performance.now()
): number {
  return Math.max(
    1,
    gitRemoteOperationRemainingMs(deadline, nowMs) - GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS
  )
}

export function gitRemoteOperationTimeoutError(): Error {
  return new Error('git timed out.')
}

function gitRemoteOperationAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function waitForOperationCleanup<T>(operation: Promise<T>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    void operation.then(finish, finish)
  })
}

export async function runWithGitRemoteOperationDeadline<T>(
  timeoutMs: number,
  run: (context: GitRemoteOperationContext) => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  if (externalSignal?.aborted) {
    throw gitRemoteOperationAbortError()
  }
  const deadline = createGitRemoteOperationDeadline(timeoutMs)
  const controller = new AbortController()
  let resolveBoundary!: (value: { boundaryError: Error }) => void
  const boundary = new Promise<{ boundaryError: Error }>((resolve) => {
    resolveBoundary = resolve
  })
  let boundaryError: Error | null = null
  const requestStop = (error: Error): void => {
    if (boundaryError) {
      return
    }
    boundaryError = error
    controller.abort()
    resolveBoundary({ boundaryError: error })
  }
  const expire = (): void => {
    requestStop(gitRemoteOperationTimeoutError())
  }
  const abort = (): void => {
    requestStop(gitRemoteOperationAbortError())
  }
  const operation = run({ deadline, signal: controller.signal }).then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  const timer = setTimeout(expire, timeoutMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
  externalSignal?.addEventListener('abort', abort, { once: true })
  if (externalSignal?.aborted) {
    abort()
  }
  try {
    const first = await Promise.race([operation, boundary])
    if ('boundaryError' in first) {
      const cleanupBudgetMs =
        first.boundaryError.name === 'AbortError'
          ? GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS
          : Math.min(
              GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS,
              gitRemoteOperationRemainingMs(deadline)
            )
      if (cleanupBudgetMs > 0) {
        await waitForOperationCleanup(operation, cleanupBudgetMs)
      }
      throw first.boundaryError
    }
    if (first.status === 'rejected') {
      throw first.reason
    }
    return first.value
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abort)
  }
}
