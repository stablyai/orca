// A terminal or agent may briefly own the same linked-worktree index.lock.
// Cover a short-lived holder (~8s) without freezing the action on a stale lock file.
export const GIT_INDEX_LOCK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

export function isGitIndexLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const fields = ['message', 'stderr'] as const
  return fields.some((field) => {
    const value = (error as Record<string, unknown>)[field]
    return (
      typeof value === 'string' &&
      /index\.lock[\s\S]*(?:file exists|another git process)/i.test(value)
    )
  })
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Abort may have happened between the initial check and listener setup.
    if (signal?.aborted) {
      onAbort()
    }
  })
}

export async function runWithGitIndexLockRetry<T>(
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      throw createAbortError()
    }
    try {
      return await run()
    } catch (error) {
      const delayMs = GIT_INDEX_LOCK_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined || !isGitIndexLockError(error)) {
        throw error
      }
      await sleepUnlessAborted(delayMs, signal)
    }
  }
}
