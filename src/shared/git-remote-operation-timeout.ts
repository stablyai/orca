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
  let rejectBoundary!: (error: Error) => void
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject
  })
  const expire = (): void => {
    controller.abort()
    rejectBoundary(gitRemoteOperationTimeoutError())
  }
  const abort = (): void => {
    controller.abort()
    rejectBoundary(gitRemoteOperationAbortError())
  }
  const timer = setTimeout(expire, timeoutMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
  externalSignal?.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([run({ deadline, signal: controller.signal }), boundary])
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abort)
  }
}
