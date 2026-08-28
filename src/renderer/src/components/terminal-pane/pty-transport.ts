import { attachIpcPty } from './ipc-pty-attach'
import { writeAcceptedIpcPtyInput } from './ipc-pty-accepted-input'
import { connectIpcPty } from './ipc-pty-connect'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { createPtyOutputProcessor } from './pty-output-processor'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'

export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  restorePtyDataHandlersAfterFailedShutdown,
  subscribeToPtyExit,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type { EagerPtyHandle } from './pty-dispatcher'
export { extractLastOscTitle } from '../../../../shared/agent-detection'
export { createPtyOutputProcessor } from './pty-output-processor'
export {
  MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY,
  MAX_PENDING_PTY_SIDE_EFFECTS
} from './pty-output-side-effect-queue'
export type {
  IpcPtyTransportOptions,
  LocalPtySessionMetadata,
  PtyBufferSnapshot,
  PtyConnectResult,
  PtyReplayDataMeta,
  PtyTransport
} from './pty-transport-types'

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    connectionId,
    cwd,
    shellOverride,
    onPtyExit,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let suppressAttentionEvents = false
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}

  const inputWriteQueue = createPtyInputWriteQueue({
    isWritable: (id) => connected && ptyId === id,
    write: (id, data) => window.api.pty.write(id, data),
    onDrainFailure: (id) => {
      if (ptyId === id) {
        storedCallbacks.onWriteUnavailable?.()
      }
    }
  })
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle: (title) => {
      if (!suppressAttentionEvents) {
        onAgentBecameIdle?.(title)
      }
    },
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })
  const handlers = createIpcPtySessionHandlers({
    outputProcessor,
    getPtyId: () => ptyId,
    getCallbacks: () => storedCallbacks,
    getSuppressAttentionEvents: () => suppressAttentionEvents,
    markExited: () => {
      connected = false
      ptyId = null
    },
    onPtyExit
  })
  const bind = (id: string): void => {
    ptyId = id
    connected = true
  }
  const setCallbacks = (callbacks: typeof storedCallbacks): void => {
    storedCallbacks = callbacks
  }

  return {
    connect: (options) =>
      connectIpcPty(options, {
        transportOptions: opts,
        handlers,
        isDestroyed: () => destroyed,
        bind,
        isCurrent: (id) => connected && ptyId === id,
        setCallbacks,
        getCallbacks: () => storedCallbacks
      }),

    attach: (options) =>
      attachIpcPty(options, {
        handlers,
        outputProcessor,
        isDestroyed: () => destroyed,
        bind,
        isCurrent: (id) => connected && ptyId === id,
        setCallbacks,
        setSuppressAttentionEvents: (value) => {
          suppressAttentionEvents = value
        }
      }),

    disconnect() {
      handlers.clearAccumulatedState()
      inputWriteQueue.clear()
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        handlers.unregisterAll(id)
        storedCallbacks.onDisconnect?.()
      }
    },

    detach(options) {
      outputProcessor.disposePendingSideEffectGauge()
      handlers.clearAccumulatedState()
      inputWriteQueue.clear()
      if (ptyId) {
        if (options?.preserveExitObserver === false) {
          handlers.unregisterAll(ptyId)
        } else {
          handlers.unregisterData(ptyId)
        }
      }
      connected = false
      ptyId = null
      storedCallbacks = {}
    },

    sendInput(data) {
      return connected && ptyId ? inputWriteQueue.enqueue(ptyId, data) : false
    },

    sendInputImmediate(data) {
      return connected && ptyId ? inputWriteQueue.enqueueQueryReply(ptyId, data) : false
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            if (!connected || !ptyId) {
              return false
            }
            const id = ptyId
            await inputWriteQueue.waitForDrain()
            if (!connected || ptyId !== id) {
              return false
            }
            return writeAcceptedIpcPtyInput(id, data, () => connected && ptyId === id)
          }
        }),

    claimViewport(cols, rows) {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.claimViewport(ptyId, cols, rows)
      return true
    },

    resize(cols, rows, meta) {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.resize(ptyId, cols, rows)
      if (meta?.claim) {
        window.api.pty.claimViewport(ptyId, cols, rows)
      }
      return true
    },

    isConnected: () => connected,
    getPtyId: () => ptyId,
    getConnectionId: () => connectionId ?? null,
    getLocalSessionMetadata: () =>
      connectionId
        ? null
        : { ...(cwd ? { cwd } : {}), ...(shellOverride ? { shellOverride } : {}) },
    resetCrossChunkParserState: outputProcessor.resetAgentStatusCarry,

    destroy() {
      destroyed = true
      try {
        this.disconnect()
      } finally {
        outputProcessor.disposePendingSideEffectGauge()
      }
    }
  }
}
