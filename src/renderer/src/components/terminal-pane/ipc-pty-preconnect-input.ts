import type { PtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import type { createPtyInputWriteQueue } from './pty-input-write-queue'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export function createIpcPtyPreconnectInput(args: {
  preconnectInputBuffer: PtyPreconnectInputBuffer | null
  inputWriteQueue: ReturnType<typeof createPtyInputWriteQueue>
  connectionId?: string
  releasePreconnectInput?: () => boolean
  isDestroyed: () => boolean
  isConnected: () => boolean
  getPtyId: () => string | null
}) {
  const {
    preconnectInputBuffer,
    inputWriteQueue,
    connectionId,
    releasePreconnectInput,
    isDestroyed,
    isConnected,
    getPtyId
  } = args
  const drop = (reason: string): void => {
    if (preconnectInputBuffer?.hasPendingInput()) {
      console.warn(
        `[pty-transport] dropped keys typed while the terminal was connecting: ${reason}`
      )
    }
    preconnectInputBuffer?.clear()
  }
  const flush = async (): Promise<void> => {
    if (!preconnectInputBuffer?.isBuffering()) {
      return
    }
    const id = getPtyId()
    if (isDestroyed() || !isConnected() || !id) {
      // Why: a closed pane's keys have no owner; only a failed attach is worth reporting.
      if (isDestroyed()) {
        preconnectInputBuffer.clear()
      } else {
        drop('the terminal did not attach')
      }
      return
    }
    if (releasePreconnectInput && !releasePreconnectInput()) {
      drop('startup work appeared before it attached')
      return
    }
    await preconnectInputBuffer.flush({
      isCurrent: () => !isDestroyed() && isConnected() && getPtyId() === id,
      sendInput: (data, inputKind) => inputWriteQueue.enqueue(id, data, inputKind),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(connectionId
        ? {}
        : {
            sendInputAccepted: (data: string, inputKind: TerminalInputKind) =>
              inputWriteQueue.enqueueAccepted(id, data, inputKind)
          })
    })
  }

  return { drop, flush }
}
