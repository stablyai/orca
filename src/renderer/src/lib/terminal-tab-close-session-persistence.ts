type PersistWorkspaceSession = () => Promise<void>

const DEFAULT_RETRY_DELAYS_MS = [100, 500, 2_000] as const

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function persistWithRetry(
  persist: PersistWorkspaceSession,
  retryDelaysMs: readonly number[]
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await persist()
      return
    } catch (error) {
      lastError = error
      const retryDelayMs = retryDelaysMs[attempt]
      if (retryDelayMs === undefined) {
        break
      }
      await delay(retryDelayMs)
    }
  }
  throw lastError
}

export function createTerminalTabCloseSessionPersistenceQueue(
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): (persist: PersistWorkspaceSession) => Promise<void> {
  let tail = Promise.resolve()
  return (persist) => {
    const queued = tail.then(() => persistWithRetry(persist, retryDelaysMs))
    tail = queued.catch(() => {})
    return queued
  }
}

export const enqueueTerminalTabCloseSessionPersistence =
  createTerminalTabCloseSessionPersistenceQueue()
