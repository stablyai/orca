/**
 * Deterministic reproduction for issue3-error-flood-stuck-terminal
 * (remote-runtime outage floods the UI with repeated raw error toasts;
 * terminal panes stay stuck after connectivity is restored).
 *
 * Three tests assert the adjudicated fix; the STA-3002 case covers reconnect
 * activation, which PR #11542 landed separately.
 *
 * Fault-injection point: window.api.runtimeEnvironments.call — the exact
 * Electron IPC boundary the remote PTY transport uses. Rejections are shaped
 * like real Electron IPC rejections: a plain Error whose message carries the
 * "Error invoking remote method 'runtimeEnvironments:call': <Name>: <msg>"
 * prefix and NO `code` property (Electron structured-clone keeps only
 * name/message/stack), which forces the renderer's message-fragment
 * classification path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/runtime-rpc-call-queue'
import { withRemoteRuntimeTailscaleHint } from '../../../../shared/remote-runtime-tailscale-hint'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

const ELECTRON_IPC_PREFIX = "Error invoking remote method 'runtimeEnvironments:call': "

/** A rejection exactly as the renderer sees it after Electron IPC strips custom props. */
function electronIpcShapedRejection(errorName: string, message: string): Error {
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
    vi.doMock('@/runtime/web-runtime-session', () => ({
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
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  it('sanity: the exact reported timeout+funnel toast text classifies as recoverable, so flood text must come from unclassified surfaces', async () => {
    const { isRecoverableRemoteRuntimeConnectionError, toRemoteRuntimeClientErrorLike } =
      await import('../../../../shared/remote-runtime-client-error-classification')
    const rendererSide = toRemoteRuntimeClientErrorLike(
      electronIpcShapedRejection('RemoteRuntimeClientError', TIMEOUT_WITH_TAILSCALE_HINT)
    )
    // Electron IPC stripped the code; the fragment list still catches this one.
    expect(rendererSide.code).toBeUndefined()
    expect(isRecoverableRemoteRuntimeConnectionError(rendererSide)).toBe(true)
    // …but the queue-overload rejection produced by the same outage (main's
    // per-selector RPC queue saturated by 15s-timeout calls) is classified
    // fatal even though its own code says "retry later".
    const overload = toRemoteRuntimeClientErrorLike(
      electronIpcShapedRejection('RuntimeRpcCallQueueOverloadError', QUEUE_OVERLOAD_RAW)
    )
    expect(overload.code).toBeUndefined()
    // DESIRED: transient capacity pressure during an outage is recoverable,
    // not a fatal red-toast error. RED on main: not in codes or fragments.
    expect(isRecoverableRemoteRuntimeConnectionError(overload)).toBe(true)
  })

  it('FLOOD: repeated identical outage-shaped send failures surface at most one red toast per pane', async () => {
    // Outage onset: the multiplexed stream subscription round-trip hangs
    // (socket black-holed), so keystrokes fall back to one-shot terminal.send
    // RPCs; main's saturated per-selector queue rejects each one instantly.
    runtimeSubscribe.mockImplementation(async () => new Promise(() => {}))
    let sendRejections = 0
    installHealthyRuntimeCallMock()
    const healthyImpl = runtimeCall.getMockImplementation()!
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.send') {
        sendRejections += 1
        throw electronIpcShapedRejection('RuntimeRpcCallQueueOverloadError', QUEUE_OVERLOAD_RAW)
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

    // Three keystroke bursts during the same outage.
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

  it('STUCK (cancel dead-end): a fatal resubscribe error leaves no recovery path after connectivity returns', async () => {
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

    // The dedicated stream dies, then a fatal retry response must leave the
    // terminal disconnected but manually revivable.
    const fatalMessage = 'Remote runtime pairing credentials expired.'
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        throw Object.assign(new Error(fatalMessage), { code: 'unauthorized' })
      }
      throw electronIpcShapedRejection('RemoteRuntimeClientError', TIMEOUT_WITH_TAILSCALE_HINT)
    })
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(fatalMessage)

    // Connectivity fully restored.
    installHealthyRuntimeCallMock()
    const subscribeCallsBeforeTriggers = runtimeSubscribe.mock.calls.length
    // Fire every built-in revival trigger the app has:
    const revivedByOnlineOrResume = retryAllRemoteRuntimePtyRecoveriesNow()
    const manualRetryAccepted = transport.retryRecovery?.() ?? false
    const reconnectBannerVisible = 1 in bannerUiState

    // DESIRED INVARIANT (RED on main): after the fault clears, at least one
    // recovery affordance must exist — the online/resume trigger revives a
    // parked retry, or the Reconnect banner is visible and its retry is
    // accepted. On main: cancel() latched phase 'idle', pendingRetry is gone,
    // the banner is unmounted, and retryRecovery() returns false — keystrokes
    // silently vanish and no output ever renders again.
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

    // Full recovery: a fresh subscribe attempt must reach the runtime.
    await vi.waitFor(() =>
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBeforeTriggers)
    )
    transport.destroy?.()
  })

  // PR #11542 owns reconnect activation for STA-3002; it has landed, so this must stay green.
  it('STUCK (STA-3002 shape): reconnect never re-materializes a host surface demoted to pending-handle, even via online trigger and Reconnect', async () => {
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

      // Host restarted during the outage: it republishes this pane as
      // status 'pending-handle' with no terminal. A real host only mints the
      // PTY handle when someone calls session.tabs.activate.
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

      // Auto-recovery deadline latches the pane 'disconnected'.
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      // Connectivity restored; 'online'/system-resume trigger fires.
      retryAllRemoteRuntimePtyRecoveriesNow()
      await vi.advanceTimersByTimeAsync(16_000)

      // Latch again, then the user clicks the Reconnect banner.
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      transport.retryRecovery?.()
      await vi.advanceTimersByTimeAsync(16_000)

      // A reconnect against a host that publishes this pane as pending-handle
      // must call session.tabs.activate (the only RPC that materializes the PTY)
      // and attach to the minted handle. Before #11542 only the initial-connect
      // path activated, so every reconnect polled session.tabs.list forever and
      // the pane stayed stuck until the user resumed the session in a new one.
      expect(
        activateCallsAfterOutage,
        `reconnect ran ${listCallsAfterOutage} list-only inventory polls across online trigger + Reconnect click without ever activating the pending surface`
      ).toBeGreaterThan(0)
      // Why: reconnect is machinery, not a user gesture, so the host must be able
      // to tell it apart and leave a deliberately slept pane slept (STA-3465).
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
