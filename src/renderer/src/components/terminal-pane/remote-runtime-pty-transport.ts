/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalCreate
} from '../../../../shared/runtime-types'
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
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '@/runtime/web-terminal-surface-id'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 0
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000

function normalizeRemoteTerminalInput(data: string): string {
  // Why: PTYs expect the Enter key as carriage return. Some browser/mobile
  // input paths can emit bare LF, which zsh renders with PROMPT_SP `%` marks.
  return data.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
}

function isRemoteTerminalGoneMessage(message: string): boolean {
  return (
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
}

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
    activate,
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
  // Why: web session mirrors attach to host-owned handles; only terminals this
  // transport created should be closed by this transport's teardown path.
  let ownsRemoteTerminal = false
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

  function findReadyHostSessionHandle(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): string | null {
    const terminalTabs = snapshot.tabs.filter((tab) => tab.type === 'terminal')
    const preferred =
      terminalTabs.find(
        (tab) =>
          tab.status === 'ready' &&
          tab.parentTabId === hostTabId &&
          (!leafId || tab.leafId === leafId)
      ) ??
      terminalTabs.find(
        (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.isActive
      ) ??
      terminalTabs.find((tab) => tab.status === 'ready' && tab.parentTabId === hostTabId)
    return preferred?.terminal ?? null
  }

  function hasHostSessionTerminalSurface(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): boolean {
    return snapshot.tabs.some(
      (tab) => tab.type === 'terminal' && (tab.parentTabId === hostTabId || tab.id === hostTabId)
    )
  }

  async function waitForHostSessionHandle(hostTabId: string): Promise<string | null> {
    if (!worktreeId) {
      return null
    }
    const worktree = `id:${worktreeId}`
    const activated = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.activate', {
      worktree,
      tabId: hostTabId
    })
    const immediate = findReadyHostSessionHandle(activated, hostTabId)
    if (immediate) {
      return immediate
    }

    const startedAt = Date.now()
    while (!destroyed) {
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return null
      }
      // Why: host mirrors can be published before their PTY handle is ready,
      // but a stuck pending surface must not poll the runtime forever.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(HOST_SESSION_ATTACH_POLL_MS, remainingMs))
      )
      const listed = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
        worktree
      })
      const handle = findReadyHostSessionHandle(listed, hostTabId)
      if (handle) {
        return handle
      }
      if (!hasHostSessionTerminalSurface(listed, hostTabId)) {
        return null
      }
    }
    return null
  }

  async function attachHostSessionMirror(
    options: Parameters<PtyTransport['connect']>[0]
  ): Promise<PtyConnectResult | undefined> {
    if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
      return undefined
    }
    const hostTabId = toHostSessionTabId(tabId)
    const hostHandle = await waitForHostSessionHandle(hostTabId)
    if (!hostHandle || destroyed) {
      if (!destroyed) {
        storedCallbacks.onError?.('Remote terminal was closed.')
      }
      return undefined
    }

    handle = hostHandle
    ownsRemoteTerminal = false
    remotePtyId = toRemoteRuntimePtyId(hostHandle, currentRuntimeEnvironmentId)
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    onPtySpawn?.(remotePtyId)

    await subscribeToHandle()
    if (destroyed || !connected || !remotePtyId) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: ''
    } satisfies PtyConnectResult
  }

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
    }).catch((error) => {
      storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
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

  function retireRemoteTerminalId(): void {
    connected = false
    const stalePtyId = remotePtyId
    handle = null
    remotePtyId = null
    multiplexedStream?.close()
    multiplexedStream = null
    if (stalePtyId) {
      onPtyExit?.(stalePtyId)
    }
  }

  function handleRemoteTerminalError(error: unknown): void {
    const message = runtimeTerminalErrorMessage(error)
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: paired web clients consume host-published PTY handles. If the host
      // retires one between snapshots, clear this mirror and wait for the next
      // session-tabs update instead of surfacing a red xterm error.
      retireRemoteTerminalId()
      return
    }
    storedCallbacks.onError?.(message)
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
        onError: (message) => handleRemoteTerminalError(message),
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
            .catch((error) => handleRemoteTerminalError(error))
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
        if (isWebTerminalSurfaceTabId(tabId ?? '')) {
          return await attachHostSessionMirror(options)
        }

        const created = await callRuntime<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: worktreeId,
          command,
          env,
          tabId,
          leafId,
          focus: false,
          ...(activate === true ? { activate: true } : {})
        })
        handle = created.terminal.handle
        ownsRemoteTerminal = true
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
      ownsRemoteTerminal = false
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      void subscribeToHandle().catch((error) => {
        handleRemoteTerminalError(error)
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
      if (ownsRemoteTerminal) {
        void closeRemoteTerminal()
      }
      handle = null
      remotePtyId = null
      ownsRemoteTerminal = false
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
      ownsRemoteTerminal = false
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle) {
        return false
      }
      const normalized = normalizeRemoteTerminalInput(data)
      if (!normalized) {
        return true
      }
      // Why: remote terminal input is user-visible. Coalesce only same-turn
      // bursts so typing does not pay the old fixed 8 ms batch delay.
      inputBatcher.push(normalized)
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
