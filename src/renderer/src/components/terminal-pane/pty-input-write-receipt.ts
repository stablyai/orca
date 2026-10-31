import type { PendingPtyInputWrite, PtyInputWriteQueueDeps } from './pty-input-write-queue-contract'

// Use per-write cancellation; queue-lifetime promise reactions retain every acknowledged write until teardown.
export async function writeAcceptedPtyChunk(
  deps: PtyInputWriteQueueDeps,
  pendingAcceptedCancels: Set<() => void>,
  item: PendingPtyInputWrite,
  data: string
): Promise<boolean> {
  let cancel = (): void => undefined
  const cancelled = new Promise<boolean>((resolve) => {
    cancel = () => resolve(false)
  })
  // Install cancellation before writes because synchronous accepted callbacks may clear the queue reentrantly.
  pendingAcceptedCancels.add(cancel)
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve(deps.writeAccepted?.(item.id, data, item.inputKind) ?? false).catch(
        () => false
      )
    ])
  } finally {
    pendingAcceptedCancels.delete(cancel)
  }
}

export function reportPtyInputDrainFailure(
  deps: PtyInputWriteQueueDeps,
  failingId: string | null,
  error: unknown,
  failureIsCurrent: boolean
): void {
  console.warn('[pty-input-write-queue] drain failed:', error)
  if (failureIsCurrent && failingId !== null) {
    try {
      deps.onDrainFailure?.(failingId)
    } catch (recoveryError) {
      console.warn('[pty-input-write-queue] failure handler failed:', recoveryError)
    }
  }
}
