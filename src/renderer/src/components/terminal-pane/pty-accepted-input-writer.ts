import type { PtyInputOperationOptions } from './pty-transport-types'
import type { PtyInputWriteQueueDeps } from './pty-input-write-queue-contract'

export function createPtyAcceptedInputWriter(
  writeAccepted: PtyInputWriteQueueDeps['writeAccepted']
) {
  const pendingCancels = new Set<() => void>()

  async function writeAcceptedChunk(
    id: string,
    data: string,
    options?: PtyInputOperationOptions
  ): Promise<boolean> {
    let cancel = (): void => undefined
    const cancelled = new Promise<boolean>((resolve) => {
      cancel = () => resolve(false)
    })
    // Register before invoking the writer so synchronous clear() cancels this write too.
    pendingCancels.add(cancel)
    try {
      return await Promise.race([
        cancelled,
        Promise.resolve(
          (options ? writeAccepted?.(id, data, options) : writeAccepted?.(id, data)) ?? false
        ).catch(() => false)
      ])
    } finally {
      pendingCancels.delete(cancel)
    }
  }

  return {
    writeAcceptedChunk,
    cancelPendingAcceptedWrites(): void {
      for (const cancel of pendingCancels) {
        cancel()
      }
      pendingCancels.clear()
    }
  }
}
