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
import { legacyRelayTransportRouting } from './legacy-relay-transport-routing'
import { SSH_SESSION_EXPIRED_ERROR } from './pty-connection/pty-connect-limits'
import { createLegacyRelayInputSource, disposeLegacyRelayViewer } from './legacy-relay-input-source'
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
  const inputSource = createLegacyRelayInputSource({
    ptyId,
    api,
    inner,
    isInner: () => mode === 'inner',
    isBridgeWritable: () => mode === 'bridge' && viewer !== null
  })

  const dropViewer = (): boolean => {
    let previous: number | null = null
    const owns = inputSource.change(
      null,
      () => {
        previous = viewer
        viewer = null
      },
      true
    )
    const version = inputSource.version()
    disposeLegacyRelayViewer(api, ptyId, previous, [])
    return owns && version === inputSource.version()
  }

  /** Issue order of this pane's attaches, and which one the held viewer came from. */
  const seqs = { issued: 0, viewer: 0 }

  // The newest issued attach retains its viewer regardless of reply order; release every other viewer.
  const adoptViewer = (seq: number, acquisitionId: number): boolean => {
    if (seq < seqs.viewer) {
      api?.detach({ ptyId, acquisitionId })
      return true
    }
    let previous: number | null = null
    const owns = inputSource.change('bridge', () => {
      previous = viewer !== acquisitionId ? viewer : null
      viewer = acquisitionId
      seqs.viewer = seq
    })
    const version = inputSource.version()
    disposeLegacyRelayViewer(api, ptyId, previous, [])
    return owns && version === inputSource.version()
  }

  const release = (nextMode = mode, unavailable = false): boolean => {
    let previous: number | null = null
    let disposers: (() => void)[] = []
    const owns = inputSource.change(
      null,
      () => {
        epoch += 1
        mode = nextMode
        previous = viewer
        viewer = null
        disposers = unsubscribe
        unsubscribe = []
      },
      unavailable
    )
    const version = inputSource.version()
    disposeLegacyRelayViewer(api, ptyId, previous, disposers)
    return owns && version === inputSource.version()
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
    const seq = ++seqs.issued
    try {
      // Replay in stream order: applying the reply’s screen would erase relay output printed after it.
      const result = await api.attach({ ptyId, replayInStream: true })
      if (!stillWanted(at, result)) {
        return
      }
      if (result.status === 'attached') {
        if (adoptViewer(seq, result.acquisitionId)) {
          clearUnreachable()
        }
      } else if (result.status === 'exited' || result.status === 'not-bridged') {
        if (!release('bridge', true)) {
          return
        }
        const version = inputSource.version()
        const previousCallbacks = callbacks
        clearUnreachable()
        if (version === inputSource.version()) {
          previousCallbacks?.onExit?.(-1)
        }
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
          if (!release('bridge', true)) {
            return
          }
          const version = inputSource.version()
          const previousCallbacks = callbacks
          clearUnreachable()
          if (version === inputSource.version()) {
            previousCallbacks?.onExit?.(event.code)
          }
        }
      }),
      onLegacyRelayBridgedPanesChanged(() => {
        const pane = legacyRelayBridgedPane(ptyId)
        if (mode !== 'bridge') {
          return
        }
        if (!pane) {
          lastState = null
          // Reconnect must reattach; a disconnected bridge proves no exit, and its replacement forwards only attached panes.
          if (dropViewer()) {
            void reattach()
          }
          return
        }
        const previous = lastState
        lastState = pane.state
        if (pane.state === 'unverifiable') {
          if (dropViewer()) {
            showUnreachable()
          }
        } else if (viewer === null && previous !== 'live') {
          // Only on the change to live: a terminal that refuses to attach waits for the next one.
          void reattach()
        }
      })
    ]
  }

  const connectBridged = async (next: Callbacks): Promise<PtyConnectResult | undefined> => {
    if (!api) {
      callbacks = next
      next.onError?.(`${SSH_SESSION_EXPIRED_ERROR}: legacy relay bridge unavailable`)
      return undefined
    }
    if (
      !inputSource.change(mode === 'bridge' && viewer !== null ? 'bridge' : null, () => {
        mode = 'bridge'
        callbacks = next
      })
    ) {
      return undefined
    }
    subscribe()
    const at = epoch
    const seq = ++seqs.issued
    const result = await api.attach({ ptyId })
    if (!stillWanted(at, result)) {
      return undefined
    }
    if (result.status === 'exited' || result.status === 'not-bridged') {
      if (!release('pending', true)) {
        return undefined
      }
      next.onError?.(`${SSH_SESSION_EXPIRED_ERROR}: the older relay no longer runs this terminal`)
      return undefined
    }
    lastState = result.status === 'attached' ? 'live' : 'unverifiable'
    if (result.status === 'unverifiable') {
      const version = inputSource.version()
      next.onConnect?.()
      if (version === inputSource.version()) {
        showUnreachable()
      }
      return { id: ptyId, isReattach: true, replay: '' }
    }
    if (!adoptViewer(seq, result.acquisitionId)) {
      return undefined
    }
    if (at !== epoch || mode !== 'bridge') {
      return undefined
    }
    const version = inputSource.version()
    next.onConnect?.()
    if (version !== inputSource.version()) {
      return undefined
    }
    return { id: ptyId, isReattach: true, replay: result.replay }
  }

  const bridged = (): boolean => mode === 'bridge'
  return {
    ...legacyRelayTransportRouting(ptyId, api, inner, bridged, () => viewer),
    getInputSource: inputSource.current,
    observeInputSource: inputSource.observe,
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
          callbacks?.onDisconnect?.()
        }
        return
      }
      inner.disconnect()
    },
    detach: (options) => {
      if (bridged()) {
        release()
        return
      }
      inner.detach?.(options)
    },
    destroy: (options) => {
      const wasBridged = bridged()
      if (wasBridged || mode === 'pending') {
        try {
          release('pending')
        } finally {
          if (wasBridged) {
            // An explicit close still owes the captured old shell's stop after reentry.
            void api?.close({ ptyId }).catch(() => {})
          }
        }
        return
      }
      return inner.destroy?.(options)
    }
  }
}
