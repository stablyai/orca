/** Inject Electron-shaped RPC rejections with codes stripped to verify message classification, bounded outage surfaces and revivable reconnect, including host-side activation of pending panes (STA-3002). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/runtime-rpc-call-queue'
import { withRemoteRuntimeTailscaleHint } from '../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import { stubRuntimeEnvironmentBridge } from '../../runtime/runtime-environment-bridge-fixture'

const ELECTRON_IPC_PREFIX = "Error invoking remote method 'runtimeEnvironments:call': "

/** A rejection exactly as the renderer sees it after Electron IPC strips custom props. */
function electronIpcRejection(errorName: string, message: string): Error {
  return new Error(`${ELECTRON_IPC_PREFIX}${errorName}: ${message}`)
}

const QUEUE_OVERLOAD_RAW = new RuntimeRpcCallQueueOverloadError('selector').message

// The exact user-reported toast text family (timeout + Tailscale funnel hint).
const TIMEOUT_WITH_TAILSCALE_HINT = withRemoteRuntimeTailscaleHint(
  'Timed out waiting for the remote Orca runtime to respond.',
  'https://orca-server.tail1234.ts.net'
)

describe('remote runtime outage: toast flood and stuck reconnect (issue3)', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
  }

  function latestSubscribePayload(): { streamId: number; terminal: string } {
    const frames = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    const frame = frames.at(-1)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{ streamId: number; terminal: string }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function subscribedTerminalHandles(): string[] {
    return subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return []
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        return payload ? [payload.terminal] : []
      })
  }

  function emitSnapshot(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function installHealthyRuntimeCallMock(): void {
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate') {
        const params = request.params as { tabId: string; leafId?: string }
        const resolvedLeafId = params.leafId ?? 'pane:1'
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `${params.tabId}::${resolvedLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${params.tabId}::${resolvedLeafId}`,
                parentTabId: params.tabId,
                leafId: resolvedLeafId,
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-1'
              }
            ]
          }
        }
      }
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-1',
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    })
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session-snapshot', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    installHealthyRuntimeCallMock()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall, subscribe: runtimeSubscribe })
  })

  it('classifies the reported timeout with its Tailscale hint as recoverable', async () => {
    const { isRecoverableRemoteRuntimeConnectionError, toRemoteRuntimeClientErrorLike } =
      await import('../../../../shared/remote-runtime/remote-runtime-client-error-classification')
    const rendererSide = toRemoteRuntimeClientErrorLike(
      electronIpcRejection('RemoteRuntimeClientError', TIMEOUT_WITH_TAILSCALE_HINT)
    )
    // Electron IPC stripped the code; the fragment list still catches this one.
    expect(rendererSide.code).toBeUndefined()
    expect(isRecoverableRemoteRuntimeConnectionError(rendererSide)).toBe(true)
    // Queue saturation is transient outage pressure even after IPC strips its retry-later code.
    const overload = toRemoteRuntimeClientErrorLike(
      electronIpcRejection('RuntimeRpcCallQueueOverloadError', QUEUE_OVERLOAD_RAW)
    )
    expect(overload.code).toBeUndefined()
    expect(isRecoverableRemoteRuntimeConnectionError(overload)).toBe(true)
  })

  it('suppresses repeated queue-overload send errors and backs off recovery', async () => {
    // Black-hole stream subscribe so typing falls back to one-shot RPCs rejected by main’s saturated queue.
    runtimeSubscribe.mockImplementation(async () => new Promise(() => {}))
    let sendRejections = 0
    installHealthyRuntimeCallMock()
    const healthyImpl = runtimeCall.getMockImplementation()!
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.send') {
        sendRejections += 1
        throw electronIpcRejection('RuntimeRpcCallQueueOverloadError', QUEUE_OVERLOAD_RAW)
      }
      return healthyImpl(request)
    })

    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const recoveryPhases: string[] = []
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {
        onError,
        onRecoveryStateChange: (state: PtyTransportRecoveryState) =>
          recoveryPhases.push(state.phase)
      }
    })
    await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))

    expect(transport.sendInputImmediate?.('k1')).toBe(true)
    await vi.waitFor(() => expect(sendRejections).toBe(1))
    expect(transport.sendInputImmediate?.('k2')).toBe(true)
    await vi.waitFor(() => expect(sendRejections).toBe(2))
    expect(transport.sendInputImmediate?.('k3')).toBe(true)
    await vi.waitFor(() => expect(sendRejections).toBe(3))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onError).not.toHaveBeenCalled()
    expect(recoveryPhases).toContain('backoff')
    transport.destroy?.()
  })

  it('keeps manual recovery available after a fatal resubscribe error', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { retryAllRemoteRuntimePtyRecoveriesNow } =
      await import('./remote-runtime-pty-recovery-state')
    const { updateTerminalRemoteRuntimeRecoveryUiState } =
      await import('./terminal-remote-runtime-recovery-ui-state')
    const onError = vi.fn()
    let bannerUiState: Parameters<typeof updateTerminalRemoteRuntimeRecoveryUiState>[0] = {}
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {
        onError,
        onRecoveryStateChange: (state: PtyTransportRecoveryState) => {
          bannerUiState = updateTerminalRemoteRuntimeRecoveryUiState(bannerUiState, 1, state)
        }
      }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'live before outage')
    expect(transport.isConnected()).toBe(true)

    // A fatal recovery response may latch offline but must preserve manual revival.
    const fatalMessage = 'Remote runtime pairing credentials expired.'
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        throw Object.assign(new Error(fatalMessage), { code: 'unauthorized' })
      }
      throw electronIpcRejection('RemoteRuntimeClientError', TIMEOUT_WITH_TAILSCALE_HINT)
    })
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(fatalMessage)

    installHealthyRuntimeCallMock()
    const subscribeCallsBeforeTriggers = runtimeSubscribe.mock.calls.length
    // Fire every built-in revival trigger the app has:
    const revivedByOnlineOrResume = retryAllRemoteRuntimePtyRecoveriesNow()
    const manualRetryAccepted = transport.retryRecovery?.() ?? false
    const reconnectBannerVisible = 1 in bannerUiState

    // After connectivity returns, require automatic revival or an actionable Reconnect surface; no silent unbound pane.
    expect(
      {
        revivedByOnlineOrResume,
        manualRetryAccepted,
        reconnectBannerVisible
      },
      'pane must remain revivable after a fatal resubscribe error'
    ).not.toEqual({
      revivedByOnlineOrResume: 0,
      manualRetryAccepted: false,
      reconnectBannerVisible: false
    })

    await vi.waitFor(() =>
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBeforeTriggers)
    )
    transport.destroy?.()
  })

  it('re-materializes a pending host surface on online and manual recovery', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./remote-runtime-pty-recovery-state')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-1'
      })
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'live before host restart')
      expect(transport.isConnected()).toBe(true)

      // Restarted host republishes a pending surface; only session.tabs.activate can mint its new handle.
      let hostActivated = false
      let activateCallsAfterOutage = 0
      let listCallsAfterOutage = 0
      const activateIntentsAfterOutage: unknown[] = []
      const hostSnapshot = () => ({
        ok: true,
        result: {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 2 + listCallsAfterOutage,
          activeGroupId: null,
          activeTabId: 'host-tab-1::leaf-1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab-1::leaf-1',
              parentTabId: 'host-tab-1',
              leafId: 'leaf-1',
              title: 'Terminal',
              isActive: true,
              ...(hostActivated
                ? { status: 'ready', terminal: 'terminal-2' }
                : { status: 'pending-handle', terminal: null })
            }
          ]
        }
      })
      runtimeCall.mockImplementation(
        async (request: { method: string; params?: { intent?: unknown } }) => {
          if (request.method === 'session.tabs.list') {
            listCallsAfterOutage += 1
            return hostSnapshot()
          }
          if (request.method === 'session.tabs.activate') {
            activateCallsAfterOutage += 1
            activateIntentsAfterOutage.push(request.params?.intent)
            hostActivated = true
            return hostSnapshot()
          }
          return { ok: true, result: {} }
        }
      )

      // Stream lost → reconnect. The resubscribe path looks for a status:'ready'
      // handle and finds only the pending surface.
      subscriptionCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(16_000)

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      retryAllRemoteRuntimePtyRecoveriesNow()
      await vi.advanceTimersByTimeAsync(16_000)

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      transport.retryRecovery?.()
      await vi.advanceTimersByTimeAsync(16_000)

      // Reconnect must activate pending surfaces; list-only polling cannot materialize their PTYs (#11542).
      expect(
        activateCallsAfterOutage,
        `reconnect ran ${listCallsAfterOutage} list-only inventory polls across online trigger + Reconnect click without ever activating the pending surface`
      ).toBeGreaterThan(0)
      // Label recovery as machinery rather than user wake so deliberately slept panes remain asleep (STA-3465).
      expect(activateIntentsAfterOutage.every((intent) => intent === 'automatic')).toBe(true)
      await vi.waitFor(() => expect(subscribedTerminalHandles()).toContain('terminal-2'))
      emitSnapshot(latestSubscribePayload().streamId, 'rematerialized')
      expect(transport.isConnected()).toBe(true)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
