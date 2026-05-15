/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { PtyConnectResult, PtyTransport, IpcPtyTransportOptions } from './pty-dispatcher'
import { createPtyOutputProcessor } from './pty-transport'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage,
  toRemoteRuntimePtyId
} from '../../runtime/runtime-terminal-stream'
import {
  getRemoteRuntimeTerminalMultiplexer,
  type RemoteRuntimeMultiplexedTerminal
} from '../../runtime/remote-runtime-terminal-multiplexer'
import {
  createRemoteRuntimePtyTextBatcher,
  createRemoteRuntimeViewportBatcher
} from './remote-runtime-pty-batching'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33

export function createRemoteRuntimePtyTransport(
  runtimeEnvironmentId: string,
  opts: IpcPtyTransportOptions = {}
): PtyTransport {
  const {
    command,
    env,
    worktreeId,
    tabId,
    leafId,
    onPtyExit,
    onPtySpawn,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let handle: string | null = null
  let remotePtyId: string | null = null
  let currentRuntimeEnvironmentId = runtimeEnvironmentId
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  let resubscribing = false
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}`
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })

  async function callRuntime<TResult>(method: string, params?: unknown): Promise<TResult> {
    const response = await window.api.runtimeEnvironments.call({
      selector: currentRuntimeEnvironmentId,
      method,
      params,
      timeoutMs: 15_000
    })
    return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
  }

  async function closeRemoteTerminal(handleOverride?: string): Promise<void> {
    const targetHandle = handleOverride ?? handle
    if (!targetHandle) {
      return
    }
    try {
      await callRuntime('terminal.close', { terminal: targetHandle })
    } catch {
      // Best-effort parity with local disconnect/kill.
    }
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    if (multiplexedStream?.sendInput(text)) {
      return
    }
    void callRuntime('terminal.send', {
      terminal: targetHandle,
      text,
      client: { id: clientId, type: 'desktop' }
    })
  })

  function sendViewportUpdate(cols: number, rows: number): void {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    if (multiplexedStream?.resize(cols, rows)) {
      return
    }
    void callRuntime('terminal.updateViewport', {
      terminal: targetHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: { cols, rows }
    }).catch(() => {})
  }

  const viewportBatcher = createRemoteRuntimeViewportBatcher(
    REMOTE_TERMINAL_VIEWPORT_FLUSH_MS,
    sendViewportUpdate
  )

  function rememberViewport(cols: number, rows: number): void {
    desiredViewport = { cols, rows }
  }

  async function subscribeToHandle(): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const nextStream = await getRemoteRuntimeTerminalMultiplexer(
      currentRuntimeEnvironmentId
    ).subscribeTerminal({
      terminal: subscribedHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: desiredViewport ?? undefined,
      callbacks: {
        onData: (data) => outputProcessor.processData(data, storedCallbacks),
        onSnapshot: (data) => {
          if (data) {
            outputProcessor.processData(data, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true
            })
          }
        },
        onSubscribed: () => {
          storedCallbacks.onConnect?.()
          storedCallbacks.onStatus?.('shell')
        },
        onEnd: () => {
          outputProcessor.clearAccumulatedState()
          connected = false
          storedCallbacks.onExit?.(0)
          storedCallbacks.onDisconnect?.()
          if (remotePtyId) {
            onPtyExit?.(remotePtyId)
          }
        },
        onError: (message) => storedCallbacks.onError?.(message),
        onFitOverrideChanged: (event) => {
          if (remotePtyId) {
            setFitOverride(remotePtyId, event.mode, event.cols, event.rows)
          }
        },
        onDriverChanged: (driver) => {
          if (remotePtyId) {
            setDriverForPty(remotePtyId, driver)
          }
        },
        onTransportClose: () => {
          multiplexedStream = null
          if (destroyed || !connected || !handle || resubscribing) {
            return
          }
          resubscribing = true
          void subscribeToHandle()
            .catch((error) => storedCallbacks.onError?.(runtimeTerminalErrorMessage(error)))
            .finally(() => {
              resubscribing = false
            })
        }
      }
    })
    if (destroyed || !connected || handle !== subscribedHandle) {
      nextStream.close()
      return
    }
    multiplexedStream = nextStream
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      if (destroyed || !worktreeId) {
        return
      }

      try {
        const created = await callRuntime<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: worktreeId,
          command,
          env,
          tabId,
          leafId,
          focus: false
        })
        handle = created.terminal.handle
        if (destroyed) {
          await closeRemoteTerminal(created.terminal.handle)
          return
        }

        remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
        connected = true
        desiredViewport = {
          cols: options.cols ?? 80,
          rows: options.rows ?? 24
        }
        onPtySpawn?.(remotePtyId)

        await subscribeToHandle()
        if (destroyed || !connected || !remotePtyId) {
          return
        }

        return {
          id: remotePtyId,
          replay: ''
        } satisfies PtyConnectResult
      } catch (error) {
        storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
        return undefined
      }
    },

    attach(options) {
      storedCallbacks = options.callbacks
      currentRuntimeEnvironmentId =
        getRemoteRuntimePtyEnvironmentId(options.existingPtyId) ?? runtimeEnvironmentId
      handle = getRemoteRuntimeTerminalHandle(options.existingPtyId)
      if (!handle) {
        connected = false
        remotePtyId = null
        storedCallbacks.onError?.('Remote runtime terminal id is invalid.')
        return
      }
      remotePtyId = options.existingPtyId
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      void subscribeToHandle().catch((error) => {
        connected = false
        storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
      })
    },

    disconnect() {
      inputBatcher.flush()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      if (!connected && !handle) {
        return
      }
      connected = false
      const id = remotePtyId
      multiplexedStream?.close()
      multiplexedStream = null
      void closeRemoteTerminal()
      handle = null
      remotePtyId = null
      storedCallbacks.onDisconnect?.()
      if (id) {
        onPtyExit?.(id)
      }
    },

    detach() {
      inputBatcher.flush()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      connected = false
      multiplexedStream?.close()
      multiplexedStream = null
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle) {
        return false
      }
      // Why: remote terminal input currently crosses the runtime RPC boundary;
      // coalescing same-frame key bursts avoids a per-keystroke remote round-trip.
      inputBatcher.push(data)
      return true
    },

    resize(cols: number, rows: number): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      // Why: xterm fit can emit resize bursts while the user drags panes or
      // restores layouts. Remote runtimes only need the last viewport in a frame.
      viewportBatcher.queue(cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return remotePtyId
    },

    destroy() {
      destroyed = true
      this.disconnect()
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
}
