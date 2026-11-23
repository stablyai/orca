import { synchronizeTerminalProviderSnapshotCapabilities } from './terminal-provider-snapshot-capability'

let resumeActiveSynchronization: (() => void) | null = null

/** The inventory's capability loop; it idles once every id has an answer and retries only unknown ones. */
export function startTerminalProviderSnapshotCapabilitySynchronization(
  livePtyIds: readonly string[]
): () => void {
  let disposed = false
  let running = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const synchronize = async (): Promise<void> => {
    retryTimer = undefined
    running = true
    let retryDelayMs: number | null
    try {
      retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(livePtyIds)
    } finally {
      running = false
    }
    if (!disposed && retryDelayMs !== null) {
      retryTimer = setTimeout(() => void synchronize(), Math.max(1, retryDelayMs))
    }
  }
  const resume = (): void => {
    if (!disposed && !running && retryTimer === undefined) {
      void synchronize()
    }
  }
  resumeActiveSynchronization = resume
  void synchronize()
  return () => {
    disposed = true
    clearTimeout(retryTimer)
    if (resumeActiveSynchronization === resume) {
      resumeActiveSynchronization = null
    }
  }
}

/** Wakes an idle inventory loop after retry debt is handed to it. */
export function resumeTerminalProviderSnapshotCapabilitySynchronization(): void {
  resumeActiveSynchronization?.()
}
