import type { LegacyRelayBridgeApi } from '../../../../preload/api/legacy-relay-bridge-api'
import type { PtyTransport } from './pty-transport-types'
import type { RemoteRuntimeSnapshotRequestOptions } from '../../runtime/remote-runtime-terminal-multiplexer-types'

/** Ordinary input keeps the bridge-or-managed-runtime route independently of retained scope. */
export function legacyRelayTransportRouting(
  ptyId: string,
  api: LegacyRelayBridgeApi | undefined,
  inner: PtyTransport,
  bridged: () => boolean,
  getViewer: () => number | null
): Omit<PtyTransport, 'connect' | 'attach' | 'disconnect' | 'detach' | 'destroy'> {
  const innerRecoveryState = inner.getRecoveryState?.bind(inner)
  const innerSnapshotOutcome = inner.serializeBufferOutcome?.bind(inner)
  return {
    ...(innerRecoveryState
      ? {
          getRecoveryState: () =>
            bridged()
              ? { phase: getViewer() !== null ? 'connected' : 'recovering', epoch: 0, attempt: 0 }
              : innerRecoveryState()
        }
      : {}),
    ...(innerSnapshotOutcome
      ? {
          serializeBufferOutcome: (opts?: RemoteRuntimeSnapshotRequestOptions) =>
            bridged()
              ? Promise.resolve({
                  availability: { kind: 'unknown-legacy-host' as const },
                  snapshot: null
                })
              : innerSnapshotOutcome(opts)
        }
      : {}),
    getConnectionId: () => (bridged() ? null : inner.getConnectionId?.()),
    ownsRecovery: () => (bridged() ? false : (inner.ownsRecovery?.() ?? false)),
    retryRecovery: () => (bridged() ? false : (inner.retryRecovery?.() ?? false)),
    setOutputPaused: (paused) => {
      if (!bridged()) {
        return inner.setOutputPaused?.(paused) ?? false
      }
      if (!api) {
        return false
      }
      api.setOutputPaused({ ptyId, paused })
      return true
    },
    sendInput: (data, inputKind) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return getViewer() !== null
      }
      return inner.sendInput(data, inputKind)
    },
    sendInputImmediate: (data) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return getViewer() !== null
      }
      return inner.sendInputImmediate(data)
    },
    sendInputAccepted: async (data, inputKind, options) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return getViewer() !== null
      }
      return inner.sendInputAccepted
        ? inner.sendInputAccepted(data, inputKind, options)
        : inner.sendInput(data, inputKind)
    },
    resize: (cols, rows, meta) => {
      if (bridged()) {
        api?.resize({ ptyId, cols, rows })
        return getViewer() !== null
      }
      return inner.resize(cols, rows, meta)
    },
    isConnected: () => (bridged() ? getViewer() !== null : inner.isConnected()),
    getPtyId: () => (bridged() ? ptyId : inner.getPtyId()),
    isConnectPending: () => (bridged() ? false : (inner.isConnectPending?.() ?? false)),
    getRuntimeEnvironmentId: () => (bridged() ? null : (inner.getRuntimeEnvironmentId?.() ?? null)),
    getExecutionHostId: () => (bridged() ? null : (inner.getExecutionHostId?.() ?? null)),
    getRemotePlatform: () => (bridged() ? null : (inner.getRemotePlatform?.() ?? null)),
    claimViewport: (cols, rows) =>
      bridged() ? false : (inner.claimViewport?.(cols, rows) ?? false),
    serializeBuffer: async (opts) => (bridged() ? null : (inner.serializeBuffer?.(opts) ?? null)),
    preserve: () => {
      if (!bridged()) {
        inner.preserve?.()
      }
    },
    abandonPreconnectInput: () => inner.abandonPreconnectInput?.(),
    notifyErrorSurfaceDismissed: () => inner.notifyErrorSurfaceDismissed?.()
  }
}
