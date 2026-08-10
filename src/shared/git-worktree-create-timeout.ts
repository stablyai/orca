// Why: creation may traverse slow content filters, but every caller still needs a closed bound.
export const GIT_WORKTREE_CREATE_TIMEOUT_MS = 180_000
export const GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS = 30 * 60_000
export const GIT_WORKTREE_CREATE_CLEANUP_TIMEOUT_MS = 30_000
export const GIT_WORKTREE_CREATE_TRANSPORT_MARGIN_MS = 5_000

export type GitWorktreeCreateDeadline = Readonly<{
  expiresAt: number
  signal?: AbortSignal
}>

export function resolveGitWorktreeCreateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_ADD_TIMEOUT_MS?.trim()
  const requested = Math.floor(Number(raw))
  const resolved = Number.isNaN(requested)
    ? GIT_WORKTREE_CREATE_TIMEOUT_MS
    : Math.min(
        Math.max(requested, GIT_WORKTREE_CREATE_TIMEOUT_MS),
        GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS
      )
  if (raw && resolved !== requested) {
    const problem = Number.isNaN(requested)
      ? 'is not a number'
      : `is outside [${GIT_WORKTREE_CREATE_TIMEOUT_MS}, ${GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS}]ms`
    console.warn(
      `[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="${raw}" ${problem}; using ${resolved}ms`
    )
  }
  return resolved
}

export function clampGitWorktreeCreateTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return resolveGitWorktreeCreateTimeoutMs()
  }
  return Math.min(
    Math.max(Math.floor(value), GIT_WORKTREE_CREATE_TIMEOUT_MS),
    GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS
  )
}

export function createGitWorktreeDeadline(
  timeoutMs: number,
  signal?: AbortSignal
): GitWorktreeCreateDeadline {
  return { expiresAt: Date.now() + timeoutMs, ...(signal ? { signal } : {}) }
}

export function createGitWorktreeCleanupDeadline(): GitWorktreeCreateDeadline {
  return createGitWorktreeDeadline(GIT_WORKTREE_CREATE_CLEANUP_TIMEOUT_MS)
}

export function gitWorktreeCreateTransportTimeoutMs(operationTimeoutMs: number): number {
  return (
    operationTimeoutMs +
    GIT_WORKTREE_CREATE_CLEANUP_TIMEOUT_MS +
    GIT_WORKTREE_CREATE_TRANSPORT_MARGIN_MS
  )
}

export function remainingGitWorktreeCreateMs(
  deadline: GitWorktreeCreateDeadline,
  step: string
): number {
  if (deadline.signal?.aborted) {
    const error = new Error(`Git worktree creation was cancelled during ${step}.`)
    error.name = 'AbortError'
    throw error
  }
  const remaining = deadline.expiresAt - Date.now()
  if (remaining <= 0) {
    throw new Error(`Git worktree creation timed out during ${step}.`)
  }
  return Math.max(1, Math.floor(remaining))
}

export async function runWithinGitWorktreeDeadline<T>(
  deadline: GitWorktreeCreateDeadline,
  step: string,
  operation: () => Promise<T>
): Promise<T> {
  const timeoutMs = remainingGitWorktreeCreateMs(deadline, step)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (handler: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      deadline.signal?.removeEventListener('abort', onAbort)
      handler()
    }
    const onAbort = (): void => {
      const error = new Error(`Git worktree creation was cancelled during ${step}.`)
      error.name = 'AbortError'
      settle(() => reject(error))
    }
    const timer = setTimeout(
      () => settle(() => reject(new Error(`Git worktree creation timed out during ${step}.`))),
      timeoutMs
    )
    deadline.signal?.addEventListener('abort', onAbort, { once: true })
    if (deadline.signal?.aborted) {
      onAbort()
      return
    }
    operation().then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    )
  })
}
