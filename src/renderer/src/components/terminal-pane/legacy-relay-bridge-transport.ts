/**
 * A runtime pane whose terminal still runs inside an older Orca's relay: it reattaches through
 * main's legacy relay bridge, and hands every other connect to the managed server's transport.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 *
 * When the bridge answers that the terminal is gone, the pane gets the host's "session expired"
 * error, which retires its binding and starts a fresh shell on the managed server. When the relay
 * can't be reached, the pane stays bound and reattaches once it can: loss of contact is never exit.
 */
import type { LegacyRelayBridgeAttachResult } from '../../../../shared/legacy-relay-bridge-contract'
import type { PtyConnectResult, PtyTransport } from './pty-transport-types'
import type { RemoteRuntimeSnapshotRequestOptions } from '../../runtime/remote-runtime-terminal-multiplexer-types'
import { SSH_SESSION_EXPIRED_ERROR } from './pty-connection/pty-connect-limits'
import {
  legacyRelayBridgedPane,
  onLegacyRelayBridgedPanesChanged
} from './legacy-relay-bridge-panes'

type Callbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

const UNREACHABLE_MESSAGE =
  'This terminal is still running on the host under an older version of Orca. Reconnecting to it…'

export function createLegacyRelayBridgeTransport(ptyId: string, inner: PtyTransport): PtyTransport {
  const api = window.api.legacyRelayBridge
  let mode: 'pending' | 'bridge' | 'inner' = 'pending'
  /** The viewer main counted for this pane's attach; null while not attached. */
  let viewer: number | null = null
  let callbacks: Callbacks | null = null
  let unsubscribe: (() => void)[] = []
  let reattaching = false
  let reattachQueued = false
  let showingUnreachable = false
  let lastState: 'live' | 'unverifiable' | null = null
  /** Bumped by release, so an attach answered after the pane left hands its viewer back. */
  let epoch = 0

  const dropViewer = (): void => {
    if (viewer !== null) {
      api?.detach({ ptyId, acquisitionId: viewer })
    }
    viewer = null
  }

  const release = (): void => {
    epoch += 1
    unsubscribe.forEach((dispose) => dispose())
    unsubscribe = []
    dropViewer()
  }

  /** False when the pane left while the attach was in flight; a late success is released. */
  const stillWanted = (at: number, result: LegacyRelayBridgeAttachResult): boolean => {
    if (at === epoch && mode === 'bridge') {
      return true
    }
    if (result.status === 'attached') {
      api?.detach({ ptyId, acquisitionId: result.acquisitionId })
    }
    return false
  }

  const showUnreachable = (): void => {
    if (!showingUnreachable) {
      showingUnreachable = true
      callbacks?.onError?.(UNREACHABLE_MESSAGE)
    }
  }

  const clearUnreachable = (): void => {
    if (showingUnreachable) {
      showingUnreachable = false
      callbacks?.onErrorCleared?.(UNREACHABLE_MESSAGE)
    }
  }

  const reattach = async (): Promise<void> => {
    if (!api || mode !== 'bridge' || unsubscribe.length === 0) {
      return
    }
    if (reattaching) {
      // The ask in flight may reach a bridge that was replaced since; ask again once it answers.
      reattachQueued = true
      return
    }
    reattaching = true
    const at = epoch
    try {
      // The screen comes through onReplay in output order: applied from this reply instead, its
      // clear would erase output the relay printed after it.
      const result = await api.attach({ ptyId, replayInStream: true })
      if (!stillWanted(at, result)) {
        return
      }
      if (result.status === 'attached') {
        viewer = result.acquisitionId
        clearUnreachable()
      } else if (result.status === 'exited' || result.status === 'not-bridged') {
        clearUnreachable()
        callbacks?.onExit?.(-1)
      }
    } finally {
      reattaching = false
      if (reattachQueued) {
        reattachQueued = false
        if (viewer === null && at === epoch) {
          void reattach()
        }
      }
    }
  }

  const subscribe = (): void => {
    if (!api || unsubscribe.length > 0) {
      return
    }
    unsubscribe = [
      api.onData((event) => {
        if (mode === 'bridge' && event.ptyId === ptyId) {
          callbacks?.onData?.(event.data)
        }
      }),
      api.onReplay((event) => {
        // Main fetched this after dropping the pane's hidden output; it replaces the stale screen.
        if (mode === 'bridge' && (viewer !== null || reattaching) && event.ptyId === ptyId) {
          callbacks?.onReplayData?.(event.replay, { clearBeforeReplay: true })
        }
      }),
      api.onExit((event) => {
        if (mode === 'bridge' && event.ptyId === ptyId) {
          clearUnreachable()
          release()
          callbacks?.onExit?.(event.code)
        }
      }),
      onLegacyRelayBridgedPanesChanged(() => {
        const pane = legacyRelayBridgedPane(ptyId)
        if (mode !== 'bridge') {
          return
        }
        if (!pane) {
          lastState = null
          // A disconnect hangs the bridge up without an exit, and the next bridge serves only panes
          // that attach to it. Ask again; it answers exited once the terminal is proven gone.
          dropViewer()
          void reattach()
          return
        }
        const previous = lastState
        lastState = pane.state
        if (pane.state === 'unverifiable') {
          dropViewer()
          showUnreachable()
        } else if (viewer === null && previous !== 'live') {
          // Only on the change to live: a terminal that refuses to attach waits for the next one.
          void reattach()
        }
      })
    ]
  }

  const connectBridged = async (next: Callbacks): Promise<PtyConnectResult | undefined> => {
    callbacks = next
    if (!api) {
      next.onError?.(`${SSH_SESSION_EXPIRED_ERROR}: legacy relay bridge unavailable`)
      return undefined
    }
    mode = 'bridge'
    subscribe()
    const at = epoch
    const result = await api.attach({ ptyId })
    if (!stillWanted(at, result)) {
      return undefined
    }
    if (result.status === 'exited' || result.status === 'not-bridged') {
      release()
      mode = 'pending'
      next.onError?.(`${SSH_SESSION_EXPIRED_ERROR}: the older relay no longer runs this terminal`)
      return undefined
    }
    next.onConnect?.()
    lastState = result.status === 'attached' ? 'live' : 'unverifiable'
    if (result.status === 'unverifiable') {
      showUnreachable()
      return { id: ptyId, isReattach: true, replay: '' }
    }
    viewer = result.acquisitionId
    return { id: ptyId, isReattach: true, replay: result.replay }
  }

  const bridged = (): boolean => mode === 'bridge'
  const innerRecoveryState = inner.getRecoveryState?.bind(inner)
  const innerSnapshotOutcome = inner.serializeBufferOutcome?.bind(inner)

  return {
    ...(innerRecoveryState
      ? {
          getRecoveryState: () =>
            bridged()
              ? { phase: viewer !== null ? 'connected' : 'recovering', epoch: 0, attempt: 0 }
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
    connect: (options) => {
      if (options.sessionId === ptyId) {
        return connectBridged(options.callbacks)
      }
      mode = 'inner'
      release()
      return inner.connect(options)
    },
    attach: (options) => {
      if (options.existingPtyId === ptyId) {
        void connectBridged(options.callbacks)
        return
      }
      mode = 'inner'
      inner.attach(options)
    },
    disconnect: () => {
      if (bridged()) {
        release()
        callbacks?.onDisconnect?.()
        return
      }
      inner.disconnect()
    },
    sendInput: (data, inputKind) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return viewer !== null
      }
      return inner.sendInput(data, inputKind)
    },
    sendInputImmediate: (data) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return viewer !== null
      }
      return inner.sendInputImmediate(data)
    },
    sendInputAccepted: async (data, inputKind, options) => {
      if (bridged()) {
        api?.write({ ptyId, data })
        return viewer !== null
      }
      return inner.sendInputAccepted
        ? inner.sendInputAccepted(data, inputKind, options)
        : inner.sendInput(data, inputKind)
    },
    resize: (cols, rows, meta) => {
      if (bridged()) {
        api?.resize({ ptyId, cols, rows })
        return viewer !== null
      }
      return inner.resize(cols, rows, meta)
    },
    isConnected: () => (bridged() ? viewer !== null : inner.isConnected()),
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
    detach: (options) => {
      if (bridged()) {
        release()
        return
      }
      inner.detach?.(options)
    },
    destroy: (options) => {
      if (bridged()) {
        // An explicit pane close: stop the shell, as the other transports' destroy does.
        void api?.close({ ptyId }).catch(() => {})
      }
      if (bridged() || mode === 'pending') {
        release()
        mode = 'pending'
        return
      }
      return inner.destroy?.(options)
    },
    abandonPreconnectInput: () => inner.abandonPreconnectInput?.(),
    notifyErrorSurfaceDismissed: () => inner.notifyErrorSurfaceDismissed?.()
  }
}
