import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import type { PtyTransport } from './pty-transport-types'

/** Keeps type-ahead on a restored screen bound to its original remote terminal. */
export function withRemoteReattachInputBuffer(transport: PtyTransport): PtyTransport {
  const sendAccepted = transport.sendInputAccepted?.bind(transport)
  let pending: ReturnType<typeof createPtyPreconnectInputBuffer> | null =
    createPtyPreconnectInputBuffer()
  let entered = false
  const clear = (): void => {
    pending?.clear()
    pending = null
  }
  const wrapped: PtyTransport = {
    ...transport,
    async connect(options) {
      const expectedId = options.sessionId
      const initialBuffer = entered ? null : pending
      entered = true
      const buffer =
        expectedId && parseRemoteRuntimePtyId(expectedId)
          ? (initialBuffer ?? createPtyPreconnectInputBuffer())
          : null
      // Restored pixels can accept typing before the first connect call begins.
      if (pending !== buffer) {
        clear()
      }
      pending = buffer
      try {
        const result = await transport.connect(options)
        if (buffer) {
          await buffer.flush({
            // A replacement endpoint must never receive the old terminal's unfinished command.
            isCurrent: () => pending === buffer && transport.getPtyId() === expectedId,
            sendInput: (data, kind) => transport.sendInput(data, kind),
            sendInputImmediate: (data) => transport.sendInputImmediate(data),
            ...(sendAccepted ? { sendInputAccepted: sendAccepted } : {})
          })
        }
        return result
      } finally {
        buffer?.clear()
        if (pending === buffer) {
          pending = null
        }
      }
    },
    sendInput(data, kind) {
      return kind !== 'query-reply' && pending?.isBuffering()
        ? pending.enqueue(data, 'ordinary', kind)
        : transport.sendInput(data, kind)
    },
    // Emulator replies stay on the immediate path; replay must not retain them as user input.
    ...(sendAccepted
      ? {
          sendInputAccepted: (data, kind, options) =>
            kind !== 'query-reply' && pending?.isBuffering()
              ? pending.enqueueAccepted(data, kind, undefined, options)
              : sendAccepted(data, kind, options)
        }
      : {}),
    attach(options) {
      entered = true
      clear()
      transport.attach(options)
    },
    disconnect() {
      entered = true
      clear()
      transport.disconnect()
    },
    ...(transport.detach
      ? {
          detach: (options) => {
            entered = true
            clear()
            transport.detach?.(options)
          }
        }
      : {}),
    destroy(options) {
      entered = true
      clear()
      return transport.destroy?.(options)
    }
  }
  transport.setConnectForRecovery?.((options) => wrapped.connect(options))
  return wrapped
}
