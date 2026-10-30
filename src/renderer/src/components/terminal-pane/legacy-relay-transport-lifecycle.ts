import type { LegacyRelayBridgeApi } from '../../../../preload/api/legacy-relay-bridge-api'
import type { PtyConnectResult, PtyTransport } from './pty-transport-types'

export type LegacyRelayTransportMode = 'pending' | 'bridge' | 'inner'

/** Lifecycle calls share the wrapper's existing transition ownership and captured cleanup. */
export function legacyRelayTransportLifecycle({
  ptyId,
  api,
  inner,
  bridged,
  getMode,
  connectBridged,
  release,
  onDisconnect
}: {
  ptyId: string
  api: LegacyRelayBridgeApi | undefined
  inner: PtyTransport
  bridged: () => boolean
  getMode: () => LegacyRelayTransportMode
  connectBridged: (
    callbacks: Parameters<PtyTransport['connect']>[0]['callbacks']
  ) => Promise<PtyConnectResult | undefined>
  release: (
    nextMode?: LegacyRelayTransportMode,
    unavailable?: boolean,
    endObservation?: boolean,
    finish?: () => void
  ) => boolean
  onDisconnect: () => void
}): Pick<PtyTransport, 'connect' | 'attach' | 'disconnect' | 'detach' | 'destroy'> {
  return {
    connect: (options) => {
      if (options.sessionId === ptyId) {
        return connectBridged(options.callbacks)
      }
      if (!release('inner')) {
        return
      }
      return inner.connect(options)
    },
    attach: (options) => {
      if (options.existingPtyId === ptyId) {
        void connectBridged(options.callbacks)
        return
      }
      if (!release('inner')) {
        return
      }
      inner.attach(options)
    },
    disconnect: () => {
      if (bridged()) {
        if (release()) {
          onDisconnect()
        }
        return
      }
      inner.disconnect()
    },
    detach: (options) => {
      const wasBridged = bridged()
      release(getMode(), false, true, wasBridged ? undefined : () => inner.detach?.(options))
    },
    destroy: (options) => {
      const wasBridged = bridged()
      if (wasBridged || getMode() === 'pending') {
        try {
          release('pending', false, true)
        } finally {
          if (wasBridged) {
            // An explicit close still owes the captured old shell's stop after reentry.
            void api?.close({ ptyId }).catch(() => {})
          }
        }
        return
      }
      let completion: void | Promise<void> = undefined
      release(getMode(), false, true, () => {
        completion = inner.destroy?.(options)
      })
      return completion
    }
  }
}
