import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { createIpcPtyProcessDescription } from './ipc-pty-process-description'
import { attachIpcPty } from './ipc-pty-attach'
import { connectIpcPty } from './ipc-pty-connect'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { ensurePtyDispatcher } from './pty-dispatcher'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { createPtyOutputProcessor } from './pty-output-processor'
import {
  createPtyPreconnectInputBuffer,
  dropPtyPreconnectInput
} from './pty-preconnect-input-buffer'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    connectionId,
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
  let onAbandonedConnect: ((ptyId: string) => boolean) | undefined
  let ptyId: string | null = null
  let lifecycleGeneration = 0
  let pendingConnectGeneration: number | null = null
  let lastExitGeneration: number | null = null
  let suppressAttentionEvents = false
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  const preconnectInputBuffer =
    opts.bufferInputUntilConnect || opts.preconnectInput?.length
      ? createPtyPreconnectInputBuffer(opts.preconnectInput)
      : null

  const inputWriteQueue = createPtyInputWriteQueue({
    isWritable: (id) => !destroyed && connected && ptyId === id,
    write: (id, data, inputKind) => window.api.pty.write(id, data, inputKind),
    writeAccepted: (id, data, inputKind) => window.api.pty.writeAccepted(id, data, inputKind),
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
    onAgentBecameIdle: (title, meta) => {
      if (!suppressAttentionEvents) {
        onAgentBecameIdle?.(title, meta)
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
    captureProcessRetirement: () => description.captureRetirement(),
    onPtyExit: (id, code) => {
      description.detach()
      onPtyExit?.(id, code)
    }
  })
  const description = createIpcPtyProcessDescription(
    !connectionId,
    () => ptyId,
    () => storedCallbacks.onSessionMetadataChanged?.(),
    opts
  )
  const bind = (id: string, incarnationId?: string): void => {
    ptyId = id
    connected = true
    description.bind(incarnationId)
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
      // Why: a closed pane's keys have no owner; only a failed attach is worth reporting.
      if (destroyed) {
        preconnectInputBuffer.clear()
      } else {
        dropPtyPreconnectInput(preconnectInputBuffer, 'the terminal did not attach')
      }
      return
    }
    await preconnectInputBuffer.flush({
      isCurrent: () => !destroyed && connected && ptyId === id,
      sendInput: (data, inputKind) => inputWriteQueue.enqueue(id, data, inputKind),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(connectionId
        ? {}
        : {
            sendInputAccepted: (data: string, inputKind: TerminalInputKind) =>
              inputWriteQueue.enqueueAccepted(id, data, inputKind)
          })
    })
  }

  return {
    getPendingEscapeTailAnsi: outputProcessor.getPendingEscapeTailAnsi,
    connect: async (options) => {
      const connectGeneration = advancePtyLifecycle()
      pendingConnectGeneration = connectGeneration
      try {
        ensurePtyDispatcher()
        const publishDescription = description.capture()
        return await connectIpcPty(options, {
          transportOptions: opts,
          handlers,
          isDestroyed: () => destroyed || lifecycleGeneration !== connectGeneration,
          isExpectedExitCurrent: () =>
            !destroyed &&
            lastExitGeneration === lifecycleGeneration &&
            lifecycleGeneration === connectGeneration + 1,
          ownsPtyId: (id) => !destroyed && connected && ptyId === id,
          handleExplicitlyClosedConnect: (id) => destroyed && (onAbandonedConnect?.(id) ?? false),
          adoptMetadata: publishDescription,
          bind,
          isCurrent: (id) => lifecycleGeneration === connectGeneration && connected && ptyId === id,
          setCallbacks,
          getCallbacks: () => storedCallbacks
        })
      } finally {
        if (pendingConnectGeneration === connectGeneration) {
          pendingConnectGeneration = null
        }
        if (lifecycleGeneration === connectGeneration) {
          await flushPreconnectInput()
        }
      }
    },

    isConnectPending: () =>
      !destroyed && ptyId === null && pendingConnectGeneration === lifecycleGeneration,

    attach: (options) => {
      const attachGeneration = advancePtyLifecycle()
      try {
        ensurePtyDispatcher()
        const publishDescription = description.capture()
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
        description.hydrate(
          options.existingPtyId,
          publishDescription,
          () => !destroyed && lifecycleGeneration === attachGeneration
        )
      } catch (error) {
        preconnectInputBuffer?.clear()
        throw error
      }
      if (lifecycleGeneration === attachGeneration) {
        void flushPreconnectInput()
      }
    },

    abandonPreconnectInput() {
      dropPtyPreconnectInput(preconnectInputBuffer, 'its pending connection was abandoned')
    },

    disconnect() {
      advancePtyLifecycle()
      preconnectInputBuffer?.clear()
      const id = ptyId
      const retire = description.captureRetirement()
      connected = false
      ptyId = null
      description.detach()
      handlers.clearAccumulatedState()
      if (id) {
        try {
          void window.api.pty
            .kill(id)
            ?.then(retire)
            .catch((error) => console.warn('[pty-transport] could not close terminal', error))
        } finally {
          handlers.unregisterAll(id)
          storedCallbacks.onDisconnect?.()
        }
      }
    },

    detach(options) {
      description.detach()
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

    sendInput(data, inputKind) {
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(data, 'ordinary', inputKind, opts.onPreconnectInput)
      }
      return !destroyed && connected && ptyId
        ? inputWriteQueue.enqueue(ptyId, data, inputKind)
        : false
    },

    sendInputImmediate(data) {
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(
          data,
          'immediate',
          'query-reply',
          opts.onPreconnectInput
        )
      }
      return !destroyed && connected && ptyId
        ? inputWriteQueue.enqueueQueryReply(ptyId, data)
        : false
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string, inputKind: TerminalInputKind): Promise<boolean> {
            if (!destroyed && preconnectInputBuffer?.isBuffering()) {
              return preconnectInputBuffer.enqueueAccepted(data, inputKind, opts.onPreconnectInput)
            }
            if (destroyed || !connected || !ptyId) {
              return false
            }
            return inputWriteQueue.enqueueAccepted(ptyId, data, inputKind)
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
    getExecutionHostId: () => getConnectionExecutionHostId(connectionId),
    getRuntimeEnvironmentId: () => null,
    getLocalSessionMetadata: description.getContext,
    resetCrossChunkParserState: outputProcessor.resetAgentStatusCarry,

    destroy(options) {
      onAbandonedConnect ??= options?.onAbandonedConnect
      destroyed = true
      try {
        this.disconnect()
      } finally {
        outputProcessor.disposePendingSideEffectGauge()
      }
    }
  }
}
