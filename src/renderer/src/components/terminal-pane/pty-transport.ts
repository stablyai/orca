import { attachIpcPty } from './ipc-pty-attach'
import { writeAcceptedIpcPtyInput } from './ipc-pty-accepted-input'
import { connectIpcPty } from './ipc-pty-connect'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { createPtyOutputProcessor } from './pty-output-processor'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'
import { sendRuntimeTerminalQuickCommand } from '../../runtime/runtime-terminal-quick-command'
import { createTerminalInputOrderingLane } from './terminal-input-ordering-lane'

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
    worktreeId,
    tabId,
    leafId,
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
  let bindingGeneration = 0
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
  const inputOrderingLane = createTerminalInputOrderingLane()
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
      inputWriteQueue.clear()
      connected = false
      ptyId = null
    },
    onPtyExit
  })
  const bind = (id: string): void => {
    // Fence queued bytes before a reconnect can reuse the same PTY id.
    inputWriteQueue.clear()
    bindingGeneration += 1
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
      inputOrderingLane.clear()
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
      inputOrderingLane.clear()
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
      const id = ptyId
      const generation = bindingGeneration
      return inputOrderingLane.enqueueInput(
        () =>
          connected && id !== null && ptyId === id && bindingGeneration === generation
            ? inputWriteQueue.enqueue(id, data)
            : false,
        data.length
      )
    },

    sendInputImmediate(data) {
      return connected && ptyId ? inputWriteQueue.enqueueQueryReply(ptyId, data) : false
    },

    async sendQuickCommand(data) {
      const targetId = ptyId
      const targetGeneration = bindingGeneration
      return inputOrderingLane.enqueueQuickCommand(async () => {
        if (
          !connected ||
          !targetId ||
          bindingGeneration !== targetGeneration ||
          !worktreeId ||
          !tabId ||
          !leafId
        ) {
          return false
        }
        await inputWriteQueue.waitForDrain()
        if (!connected || ptyId !== targetId || bindingGeneration !== targetGeneration) {
          return false
        }
        return await sendRuntimeTerminalQuickCommand({
          worktreeId,
          tabId,
          leafId,
          expectedPtyId: targetId,
          text: data,
          isCurrent: () => connected && ptyId === targetId && bindingGeneration === targetGeneration
        })
      })
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            const id = ptyId
            const generation = bindingGeneration
            return inputOrderingLane.enqueueQuickCommand(async () => {
              if (!connected || !id || ptyId !== id || bindingGeneration !== generation) {
                return false
              }
              await inputWriteQueue.waitForDrain()
              if (!connected || ptyId !== id || bindingGeneration !== generation) {
                return false
              }
              return writeAcceptedIpcPtyInput(
                id,
                data,
                () => connected && ptyId === id && bindingGeneration === generation
              )
            })
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
