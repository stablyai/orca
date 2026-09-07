import { attachIpcPty } from './ipc-pty-attach'
import { connectIpcPty } from './ipc-pty-connect'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { createPtyOutputProcessor } from './pty-output-processor'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
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
  let lifecycleGeneration = 0
  let lastExitGeneration: number | null = null
  let suppressAttentionEvents = false
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  const preconnectInputBuffer =
    opts.bufferInputUntilConnect || opts.preconnectInput?.length
      ? createPtyPreconnectInputBuffer(opts.preconnectInput)
      : null

  const inputWriteQueue = createPtyInputWriteQueue({
    isWritable: (id) => !destroyed && connected && ptyId === id,
    write: (id, data) => window.api.pty.write(id, data),
    writeAccepted: (id, data) => window.api.pty.writeAccepted(id, data),
    onDrainFailure: (id) => {
      if (ptyId === id) {
        storedCallbacks.onWriteUnavailable?.()
      }
    }
  })
  const advancePtyLifecycle = (): number => {
    lifecycleGeneration += 1
    lastExitGeneration = null
    inputWriteQueue.clear()
    return lifecycleGeneration
  }
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
      advancePtyLifecycle()
      lastExitGeneration = lifecycleGeneration
      connected = false
      ptyId = null
      preconnectInputBuffer?.clear()
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
  const flushPreconnectInput = async (): Promise<void> => {
    if (!preconnectInputBuffer?.isBuffering()) {
      return
    }
    const id = ptyId
    if (destroyed || !connected || !id) {
      preconnectInputBuffer.clear()
      return
    }
    await preconnectInputBuffer.flush({
      isCurrent: () => !destroyed && connected && ptyId === id,
      sendInput: (data) => inputWriteQueue.enqueue(id, data),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(connectionId
        ? {}
        : {
            sendInputAccepted: (data: string) => inputWriteQueue.enqueueAccepted(id, data)
          })
    })
  }

  return {
    connect: async (options) => {
      const connectGeneration = advancePtyLifecycle()
      try {
        return await connectIpcPty(options, {
          transportOptions: opts,
          handlers,
          isDestroyed: () => destroyed || lifecycleGeneration !== connectGeneration,
          isExpectedExitCurrent: () =>
            !destroyed &&
            lastExitGeneration === lifecycleGeneration &&
            lifecycleGeneration === connectGeneration + 1,
          ownsPtyId: (id) => !destroyed && connected && ptyId === id,
          bind,
          isCurrent: (id) => lifecycleGeneration === connectGeneration && connected && ptyId === id,
          setCallbacks,
          getCallbacks: () => storedCallbacks
        })
      } finally {
        if (lifecycleGeneration === connectGeneration) {
          await flushPreconnectInput()
        }
      }
    },

    attach: (options) => {
      const attachGeneration = advancePtyLifecycle()
      try {
        attachIpcPty(options, {
          handlers,
          outputProcessor,
          isDestroyed: () => destroyed || lifecycleGeneration !== attachGeneration,
          bind,
          isCurrent: (id) => lifecycleGeneration === attachGeneration && connected && ptyId === id,
          setCallbacks,
          setSuppressAttentionEvents: (value) => {
            suppressAttentionEvents = value
          }
        })
      } catch (error) {
        preconnectInputBuffer?.clear()
        throw error
      }
      if (lifecycleGeneration === attachGeneration) {
        void flushPreconnectInput()
      }
    },

    abandonPreconnectInput() {
      preconnectInputBuffer?.clear()
    },

    disconnect() {
      advancePtyLifecycle()
      preconnectInputBuffer?.clear()
      const id = ptyId
      connected = false
      ptyId = null
      handlers.clearAccumulatedState()
      if (id) {
        try {
          window.api.pty.kill(id)
        } finally {
          handlers.unregisterAll(id)
          storedCallbacks.onDisconnect?.()
        }
      }
    },

    detach(options) {
      advancePtyLifecycle()
      outputProcessor.disposePendingSideEffectGauge()
      handlers.clearAccumulatedState()
      preconnectInputBuffer?.clear()
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
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(data, 'ordinary', opts.onPreconnectInput)
      }
      return !destroyed && connected && ptyId ? inputWriteQueue.enqueue(ptyId, data) : false
    },

    sendInputImmediate(data) {
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(data, 'immediate', opts.onPreconnectInput)
      }
      return !destroyed && connected && ptyId
        ? inputWriteQueue.enqueueQueryReply(ptyId, data)
        : false
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            if (!destroyed && preconnectInputBuffer?.isBuffering()) {
              return preconnectInputBuffer.enqueueAccepted(data, opts.onPreconnectInput)
            }
            if (destroyed || !connected || !ptyId) {
              return false
            }
            return inputWriteQueue.enqueueAccepted(ptyId, data)
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
        : { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(shellOverride ? { shellOverride } : {}) },
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
