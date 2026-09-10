import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

describe('remote runtime pty reattach after the bounded recovery window', () => {
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
  let hostListCalls = 0

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
  }

  function latestSubscribePayload(): { streamId: number; terminal: string } {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
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

  function hostSnapshot(
    terminal: string,
    snapshotVersion: number,
    publicationEpoch: string
  ): RuntimeMobileSessionTabsResult {
    return {
      worktree: 'wt-1',
      publicationEpoch,
      snapshotVersion,
      activeGroupId: null,
      activeTabId: 'tab-1::pane:1',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'tab-1::pane:1',
          parentTabId: 'tab-1',
          leafId: 'pane:1',
          title: 'Claude Code',
          isActive: true,
          status: 'ready',
          terminal
        }
      ]
    }
  }

  async function attachStalePane() {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtyRebind: vi.fn()
    })
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    // The host keeps publishing the same live handle, so bounded replacement polling finds
    // no replacement and stops quietly without retiring the pane.
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method !== 'session.tabs.list') {
        return { ok: true, result: {} }
      }
      hostListCalls += 1
      return { ok: true, result: hostSnapshot('terminal-stale', hostListCalls + 1, 'epoch-1') }
    })
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'terminal_handle_stale'
      }
    })
    return { transport, onError, onPtyExit }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    hostListCalls = 0
    subscriptionSendBinary.mockReset()
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate') {
        return { ok: true, result: hostSnapshot('terminal-stale', 1, 'epoch-1') }
      }
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-stale',
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: 'terminal-stale' } } }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  it('reattaches from a rotated host handle published after the recovery cutoff', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onPtyExit } = await attachStalePane()
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')

      await vi.advanceTimersByTimeAsync(16_000)
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
      expect(transport.getRecoveryState?.().phase).not.toBe('disconnected')

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      // The cutoff must not tear down the accepted-snapshot listener; it is the only path back.
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-after-timeout', 3, 'epoch-2'),
        'env-1'
      )
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-timeout' })
      )

      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-after-timeout')
      expect(onPtyExit).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reattaches when the post-cutoff snapshot republishes the same live handle', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onError } = await attachStalePane()
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 6_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const listCallsAtCutoff = hostListCalls

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-stale', 3, 'epoch-2'),
        'env-1'
      )
      await vi.waitFor(() => expect(subscribedTerminalHandles()).toHaveLength(2))

      expect(subscribedTerminalHandles()).toEqual(['terminal-stale', 'terminal-stale'])
      // The snapshot is already-received host evidence; reattaching must cost no inventory RPC.
      expect(hostListCalls).toBe(listCallsAtCutoff)
      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a same-handle snapshot while automatic recovery is still running', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = await attachStalePane()
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')

      await vi.advanceTimersByTimeAsync(16_000)
      expect(transport.getRecoveryState?.().phase).not.toBe('disconnected')

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-stale', 3, 'epoch-2'),
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(1_000)

      expect(subscribedTerminalHandles()).toEqual(['terminal-stale'])
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reattaches from a same-handle snapshot delivered inside the Reconnect window', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onError } = await attachStalePane()
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 6_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
      const listCallsAtCutoff = hostListCalls

      expect(transport.retryRecovery?.()).toBe(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(hostListCalls).toBeGreaterThan(listCallsAtCutoff)

      // Reconnect must not disarm the only path back: the click opens a window, it does not spend one.
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-stale', 4, 'epoch-3'),
        'env-1'
      )
      await vi.waitFor(() => expect(subscribedTerminalHandles()).toHaveLength(2))

      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('revives a latched require-replacement pane when online or system resume fires', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onError } = await attachStalePane()
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./remote-runtime-pty-recovery-state')

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 6_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const listCallsAtCutoff = hostListCalls

      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(hostListCalls).toBeGreaterThan(listCallsAtCutoff)

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-stale', 4, 'epoch-3'),
        'env-1'
      )
      await vi.waitFor(() => expect(subscribedTerminalHandles()).toHaveLength(2))

      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves Reconnect available when online fires on a pane latched during the attach wait', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { retryAllRemoteRuntimePtyRecoveriesNow } =
        await import('./remote-runtime-pty-recovery-state')
      runtimeCall.mockImplementation(async (request: { method: string }) => {
        if (request.method === 'session.tabs.activate') {
          return {
            ok: false,
            error: {
              code: 'remote_runtime_unavailable',
              message: 'Remote Orca runtime connection closed'
            }
          }
        }
        return { ok: true, result: {} }
      })
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit: vi.fn(),
        onPtyRebind: vi.fn()
      })
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-stale',
        cols: 80,
        rows: 24,
        callbacks: { onError: vi.fn() }
      })

      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 6_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      const callsBeforeRetry = runtimeCall.mock.calls.length
      // The attach wait is single-shot and the cutoff already settled it; replaying it would spin the banner with no RPC in flight.
      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(runtimeCall.mock.calls.length).toBe(callsBeforeRetry)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  // #12683: a fatal resubscribe latches the banner via markDisconnected(), but that latch is not
  // evidence the auto-recovery window ran out, so it must not license reattaching a fenced handle.
  it('does not reattach a fenced same handle when only a UI latch closed the window', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit: vi.fn(),
        onPtyRebind: vi.fn()
      })
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-stale',
        cols: 80,
        rows: 24,
        callbacks: { onError: vi.fn() }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'live before the drop')

      // The host keeps publishing the same handle, so no replacement can ever arrive.
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        hostListCalls += 1
        return { ok: true, result: hostSnapshot('terminal-stale', hostListCalls + 1, 'epoch-1') }
      })
      // The stream drops and the resubscribe fails fatally with a stale handle: markDisconnected()
      // latches the banner, then stale routing fences the handle with require-replacement.
      // Only that one attempt fails, so a later reattach would succeed and be observable.
      runtimeSubscribe.mockImplementationOnce(async () => {
        throw new Error('terminal_handle_stale')
      })
      subscriptionCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(16_000)
      expect(transport.getRecoveryState?.().phase).not.toBe('idle')

      const subscribesBeforeRepublish = subscribedTerminalHandles().length
      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        hostSnapshot('terminal-stale', 9, 'epoch-2'),
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(1_000)

      // The recovery deadline never fired, so the fenced handle stays fenced.
      expect(subscribedTerminalHandles()).toHaveLength(subscribesBeforeRepublish)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
