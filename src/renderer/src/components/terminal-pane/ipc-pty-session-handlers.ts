import {
  drainRolledBackPtyShutdownData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyExitHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers,
  ptyTeardownHandlers,
  ptyWriteUnavailableHandlers,
  type PtyDataMeta
} from './pty-dispatcher'
import {
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit,
  hasPreHandlerPtyExit
} from './pty-pre-handler-buffer'
import type { createPtyOutputProcessor } from './pty-output-processor'
import type { IpcPtyTransportOptions, PtyTransport } from './pty-transport-types'

type PtyCallbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

type IpcPtySessionHandlersOptions = {
  outputProcessor: ReturnType<typeof createPtyOutputProcessor>
  getPtyId: () => string | null
  getCallbacks: () => PtyCallbacks
  getSuppressAttentionEvents: () => boolean
  markExited: () => void
  onPtyExit?: IpcPtyTransportOptions['onPtyExit']
}

export type IpcPtySessionHandlers = {
  registerData: (id: string) => void
  registerExit: (id: string) => boolean
  unregisterAll: (id: string) => void
  unregisterData: (id: string) => void
  clearAccumulatedState: () => void
}

export function createIpcPtySessionHandlers({
  outputProcessor,
  getPtyId,
  getCallbacks,
  getSuppressAttentionEvents,
  markExited,
  onPtyExit
}: IpcPtySessionHandlersOptions): IpcPtySessionHandlers {
  const ownedDataHandlers = new Map<
    string,
    {
      data: (data: string, meta?: PtyDataMeta) => void
      replay: (data: string) => void
      writeUnavailable: () => void
    }
  >()
  const ownedExitHandlers = new Map<string, (code: number) => void>()

  function clearAccumulatedState(): void {
    outputProcessor.clearAccumulatedState()
  }

  const shutdownLifecycle = {
    pause: outputProcessor.pausePendingSideEffects,
    rollback: outputProcessor.flushPendingSideEffects,
    commit: clearAccumulatedState
  }

  function unregisterData(id: string): void {
    const owned = ownedDataHandlers.get(id)
    if (owned) {
      if (ptyDataHandlers.get(id) === owned.data) {
        ptyDataHandlers.delete(id)
      }
      if (ptyReplayHandlers.get(id) === owned.replay) {
        ptyReplayHandlers.delete(id)
      }
      if (ptyWriteUnavailableHandlers.get(id) === owned.writeUnavailable) {
        ptyWriteUnavailableHandlers.delete(id)
      }
    }
    ownedDataHandlers.delete(id)
  }

  function unregisterAll(id: string): void {
    unregisterData(id)
    const ownedExit = ownedExitHandlers.get(id)
    if (ownedExit && ptyExitHandlers.get(id) === ownedExit) {
      ptyExitHandlers.delete(id)
    }
    ownedExitHandlers.delete(id)
    if (ptyTeardownHandlers.get(id) === clearAccumulatedState) {
      ptyTeardownHandlers.delete(id)
    }
    if (ptyShutdownLifecycleHandlers.get(id) === shutdownLifecycle) {
      ptyShutdownLifecycleHandlers.delete(id)
    }
  }

  function registerData(id: string): void {
    const replay = (data: string): void => {
      if (getPtyId() !== id) {
        return
      }
      const callbacks = getCallbacks()
      if (callbacks.onReplayData) {
        callbacks.onReplayData(data)
      } else {
        callbacks.onData?.(data)
      }
    }
    const data = (chunk: string, meta?: PtyDataMeta): void => {
      if (getPtyId() !== id) {
        return
      }
      outputProcessor.processData(
        chunk,
        getCallbacks(),
        { suppressAttentionEvents: getSuppressAttentionEvents() },
        meta
      )
    }
    const writeUnavailable = (): void => {
      if (getPtyId() === id) {
        getCallbacks().onWriteUnavailable?.()
      }
    }
    ptyReplayHandlers.set(id, replay)
    ptyDataHandlers.set(id, data)
    ptyWriteUnavailableHandlers.set(id, writeUnavailable)
    ownedDataHandlers.set(id, { data, replay, writeUnavailable })
    if (!isPtyDataHandlerShutdownPending(id)) {
      drainPreHandlerPtyData(id, data)
      drainRolledBackPtyShutdownData(id)
    }
  }

  function registerExit(id: string): boolean {
    const hadBufferedExit = hasPreHandlerPtyExit(id)
    const exit = (code: number): void => {
      const currentId = getPtyId()
      if (currentId !== null && currentId !== id) {
        unregisterAll(id)
        return
      }
      clearAccumulatedState()
      markExited()
      unregisterAll(id)
      const callbacks = getCallbacks()
      callbacks.onExit?.(code)
      callbacks.onDisconnect?.()
      onPtyExit?.(id, code)
    }
    ptyExitHandlers.set(id, exit)
    ownedExitHandlers.set(id, exit)
    ptyTeardownHandlers.set(id, clearAccumulatedState)
    ptyShutdownLifecycleHandlers.set(id, shutdownLifecycle)
    try {
      drainPreHandlerPtyExit(id, exit)
    } catch (error) {
      if (!hadBufferedExit) {
        throw error
      }
      console.error('[pty] buffered pre-attach exit cleanup failed', error)
    }
    return hadBufferedExit
  }

  return { registerData, registerExit, unregisterAll, unregisterData, clearAccumulatedState }
}
