import type { PtyTransport } from './pty-transport-types'

export function createUnresolvedOwnerPtyTransport(message: string): PtyTransport {
  return {
    connect: ({ callbacks }) => {
      callbacks.onError?.(message)
    },
    attach: ({ callbacks }) => {
      callbacks.onError?.(message)
    },
    disconnect: () => {},
    sendInput: () => false,
    sendInputImmediate: () => false,
    resize: () => false,
    isConnected: () => false,
    getPtyId: () => null
  }
}
