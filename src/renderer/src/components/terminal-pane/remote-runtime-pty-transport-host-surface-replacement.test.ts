import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps the regular TUI and draft through inventory failure and stale-handle reconnect', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const renderedScreen: string[] = []
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtySpawn,
      onPtyRebind
    })

    resolvedPaneHandle = 'terminal-stale'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: {
        onError,
        onExit,
        onDisconnect,
        onData: (data) => renderedScreen.push(data),
        onReplayData: (data) => renderedScreen.push(data)
      }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const initialStreamId = latestSubscribePayload().streamId
    const draft = 'QA regular reconnect draft - keep this unsent'
    emitOutput(initialStreamId, draft)

    let hostListCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        // Why: this host publishes the replacement only through its own inventory, so activation answers with nothing.
        return { ok: true, result: { tabs: [] } }
      }
      if (args.method === 'session.tabs.list') {
        hostListCalls += 1
        if (hostListCalls === 1) {
          throw new Error('runtime reconnect in progress')
        }
        const terminal =
          hostListCalls === 2
            ? 'terminal-stale'
            : hostListCalls === 3
              ? null
              : 'terminal-reconnected'
        return {
          ok: true,
          result: {
            worktree: 'wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: hostListCalls + 1,
            activeGroupId: null,
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Claude Code',
                isActive: true,
                status: terminal ? 'ready' : 'pending-handle',
                terminal
              }
            ]
          }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId: initialStreamId, message: 'terminal_handle_stale' }
    })

    await vi.waitFor(() => expect(hostListCalls).toBeGreaterThanOrEqual(1))
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-stale' })
    expect(onPtyExit).not.toHaveBeenCalled()
    await vi.waitFor(
      () => expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-reconnected' }),
      { timeout: 6_000 }
    )
    const replacementStreamId = latestSubscribePayload().streamId
    emitSnapshot(replacementStreamId, draft)

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyRebind).toHaveBeenCalledOnce()
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:env-1@@terminal-reconnected',
      'remote:env-1@@terminal-stale'
    )
    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-reconnected')
    expect(transport.isConnected()).toBe(true)
    expect(renderedScreen.at(-1)).toBe(draft)
    expect(hostListCalls).toBe(4)
    const subscribedTerminals = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return []
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        return payload ? [payload.terminal] : []
      })
    expect(subscribedTerminals).toEqual(['terminal-stale', 'terminal-reconnected'])
    transport.destroy?.()
  })

  it('reattaches from a later host snapshot after bounded replacement polling stops', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onPtyExit = vi.fn()
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit,
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-stale'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-stale',
        cols: 80,
        rows: 24,
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

      let hostListCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return {
            ok: false,
            error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
          }
        }
        if (args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        hostListCalls += 1
        return {
          ok: true,
          result: {
            worktree: 'wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: hostListCalls + 1,
            activeGroupId: null,
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Claude Code',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-stale'
              }
            ]
          }
        }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: latestSubscribePayload().streamId,
          message: 'terminal_handle_stale'
        }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(hostListCalls).toBeGreaterThan(1)
      expect(hostListCalls).toBeLessThan(25)
      // The reconnect opens with a materialize (session.tabs.activate) and then
      // polls the inventory, so the first list runs one backoff into the budget.
      const listTimeouts = runtimeCall.mock.calls
        .map(([args]) => args)
        .filter((args) => args.method === 'session.tabs.list')
        .map((args) => args.timeoutMs as number)
      expect(listTimeouts[0]).toBeGreaterThan(14_000)
      expect(listTimeouts[0]).toBeLessThanOrEqual(15_000)
      expect(listTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 15_000)).toBe(true)
      expect(listTimeouts.at(-1)).toBeLessThanOrEqual(1_000)
      expect(onError).not.toHaveBeenCalled()
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-stale')
      // Cached pixels and a known PTY id do not imply that input/output is attached.
      expect(transport.isConnected()).toBe(false)
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

      const listCallsAfterBound = hostListCalls
      await expect(transport.sendInputAccepted?.('retry while reconnecting')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(16_000)

      // The accepted-snapshot listener already owns recovery. User input must
      // not turn a bounded reconnect into recurring host-inventory polling.
      expect(hostListCalls).toBe(listCallsAfterBound)
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude Code',
              isActive: true,
              status: 'ready',
              terminal: 'terminal-after-timeout'
            }
          ]
        },
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-timeout' })
      )

      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-after-timeout',
        'remote:env-1@@terminal-stale'
      )
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-after-timeout')
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      const subscribedTerminals = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .flatMap((frame) => {
          if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
            return []
          }
          const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
          return payload ? [payload.terminal] : []
        })
      expect(subscribedTerminals).toEqual(['terminal-stale', 'terminal-after-timeout'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('materializes a host surface whose PTY died instead of polling a dead inventory', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onPtyExit = vi.fn()
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit,
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-before-restart'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-before-restart',
        cols: 80,
        rows: 24,
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const activateCalls = (): {
        method: string
        params?: { tabId?: string; leafId?: string }
      }[] =>
        runtimeCall.mock.calls
          .map(([args]) => args)
          .filter((args) => args.method === 'session.tabs.activate')
      const activateCallsBeforeStale = activateCalls().length

      // The host still publishes the surface, but only activation can mint its replacement handle.
      let materialized = false
      const hostSnapshot = (): unknown => ({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-2',
        snapshotVersion: materialized ? 3 : 2,
        activeGroupId: null,
        activeTabId: 'tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1::pane:1',
            parentTabId: 'tab-1',
            leafId: 'pane:1',
            title: 'Claude Code',
            isActive: true,
            ...(materialized
              ? { status: 'ready', terminal: 'terminal-after-restart' }
              : { status: 'pending-handle', terminal: null })
          }
        ]
      })
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.activate') {
          materialized = true
          return { ok: true, result: hostSnapshot() }
        }
        if (args.method === 'session.tabs.list') {
          return { ok: true, result: hostSnapshot() }
        }
        return { ok: true, result: {} }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: latestSubscribePayload().streamId,
          message: 'terminal_handle_stale'
        }
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(activateCalls().length).toBeGreaterThan(activateCallsBeforeStale)
      expect(activateCalls().at(-1)?.params).toMatchObject({
        tabId: 'tab-1',
        leafId: 'pane:1',
        notifyClients: false,
        navigation: 'caller'
      })
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-restart' })
      )
      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-after-restart',
        'remote:env-1@@terminal-before-restart'
      )
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-activates when a stale ready activation response precedes the pending surface', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onPtyExit = vi.fn()
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit,
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-before-restart'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-before-restart',
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      runtimeCall.mockClear()

      let activateCalls = 0
      const snapshot = (terminal: string | null): unknown => ({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-2',
        snapshotVersion: activateCalls + 2,
        activeGroupId: null,
        activeTabId: 'tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1::pane:1',
            parentTabId: 'tab-1',
            leafId: 'pane:1',
            title: 'Terminal',
            isActive: true,
            ...(terminal
              ? { status: 'ready', terminal }
              : { status: 'pending-handle', terminal: null })
          }
        ]
      })
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.activate') {
          activateCalls += 1
          // Why: the first activation races host publication and answers with the pre-restart handle.
          return {
            ok: true,
            result: snapshot(
              activateCalls === 1 ? 'terminal-before-restart' : 'terminal-after-restart'
            )
          }
        }
        if (args.method === 'session.tabs.list') {
          return { ok: true, result: snapshot(null) }
        }
        return { ok: true, result: {} }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: latestSubscribePayload().streamId,
          message: 'terminal_handle_stale'
        }
      })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(
        runtimeCall.mock.calls
          .map(([args]) => args.method)
          .filter((method) => method === 'session.tabs.activate' || method === 'session.tabs.list')
      ).toEqual(['session.tabs.activate', 'session.tabs.list', 'session.tabs.activate'])
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-restart' })
      )
      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-after-restart',
        'remote:env-1@@terminal-before-restart'
      )
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
