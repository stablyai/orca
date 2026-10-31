import type { IpcPtyTransportOptions } from './pty-transport-types'
import type { PtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import type { createPtyInputWriteQueue } from './pty-input-write-queue'

type IpcPtyPreconnectContext = {
  readonly destroyed: boolean
  readonly connected: boolean
  readonly ptyId: string | null
  connectionId: IpcPtyTransportOptions['connectionId']
  opts: IpcPtyTransportOptions
  preconnectInputBuffer: PtyPreconnectInputBuffer | null
  inputWriteQueue: ReturnType<typeof createPtyInputWriteQueue>
}

export function createIpcPtyPreconnectInput(context: IpcPtyPreconnectContext) {
  const { opts, connectionId, preconnectInputBuffer, inputWriteQueue } = context
  const dropPreconnectInput = (reason: string): void => {
    if (preconnectInputBuffer?.hasPendingInput()) {
      console.warn(
        `[pty-transport] dropped keys typed while the terminal was connecting: ${reason}`
      )
    }
    preconnectInputBuffer?.clear()
  }
  const flushPreconnectInput = async (): Promise<void> => {
    if (!preconnectInputBuffer?.isBuffering()) {
      return
    }
    const id = context.ptyId
    if (context.destroyed || !context.connected || !id) {
      // Why: a closed pane's keys have no owner; only a failed attach is worth reporting.
      if (context.destroyed) {
        preconnectInputBuffer.clear()
      } else {
        dropPreconnectInput('the terminal did not attach')
      }
      return
    }
    if (opts.releasePreconnectInput && !opts.releasePreconnectInput()) {
      dropPreconnectInput('startup work appeared before it attached')
      return
    }
    await preconnectInputBuffer.flush({
      ptyId: id,
      isCurrent: () => !context.destroyed && context.connected && context.ptyId === id,
      handlesInputEligibility: true,
      sendInput: (data, inputKind, call) => inputWriteQueue.enqueue(id, data, inputKind, call),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(connectionId
        ? {}
        : {
            sendInputAccepted: (data, inputKind, options) =>
              inputWriteQueue.enqueueAccepted(id, data, inputKind, options?.call)
          })
    })
  }

  return { dropPreconnectInput, flushPreconnectInput }
}
