import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
  latestFrameForOpcode,
  emitSnapshotFrame,
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

  it('falls back to inventory when activation fails for a non-missing reason', async () => {
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

      const replacementSnapshot = {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-2',
        snapshotVersion: 2,
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
            status: 'ready',
            terminal: 'terminal-after-restart'
          }
        ]
      }
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.activate') {
          // Why: an older host has no activation method at all, which is not evidence the surface is gone.
          return { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
        }
        if (args.method === 'session.tabs.list') {
          return { ok: true, result: replacementSnapshot }
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

      expect(
        runtimeCall.mock.calls
          .map(([args]) => args.method)
          .filter((method) => method === 'session.tabs.activate' || method === 'session.tabs.list')
      ).toEqual(['session.tabs.activate', 'session.tabs.list'])
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

  it('retries activation when inventory disproves a transient missing-surface response', async () => {
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
      const pendingSnapshot = {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-2',
        snapshotVersion: 2,
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
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.activate') {
          activateCalls += 1
          if (activateCalls === 1) {
            return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
          }
          return {
            ok: true,
            result: {
              ...pendingSnapshot,
              snapshotVersion: 3,
              tabs: [
                {
                  ...pendingSnapshot.tabs[0],
                  status: 'ready',
                  terminal: 'terminal-after-restart'
                }
              ]
            }
          }
        }
        if (args.method === 'session.tabs.list') {
          return { ok: true, result: pendingSnapshot }
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mounted HUB mirror alive when the old stream ends before the replacement snapshot', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
    const onPtyExit = vi.fn()
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const onExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-before-restart',
      cols: 100,
      rows: 30,
      callbacks: { onExit }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    emitSnapshot(oldStreamId, 'before restart')
    expect(transport.isConnected()).toBe(true)

    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' ? new Promise(() => {}) : { ok: true, result: {} }
    )
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId, code: 0 }
    })
    const replacementSnapshot = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    let snapshotSettled = false
    void replacementSnapshot?.then(() => {
      snapshotSettled = true
    })
    await Promise.resolve()

    expect(onExit).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-1')
    expect(snapshotSettled).toBe(false)
    expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

    handleEvents.queueAcceptedWebSessionTerminalSnapshot(
      {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-after-restart',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'host-tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::pane:1',
            parentTabId: 'host-tab-1',
            leafId: 'pane:1',
            title: 'Terminal',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-after-restart'
          }
        ]
      },
      'hub-env'
    )

    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-restart' })
    )
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-after-restart')
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:hub-env@@terminal-after-restart',
      'remote:hub-env@@terminal-1'
    )
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    emitSnapshot(latestSubscribePayload().streamId, 'replacement initial state')
    await vi.waitFor(() =>
      expect(latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)).toBeDefined()
    )
    const requestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const request = requestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(requestFrame.payload)
      : null
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: request?.requestId,
        cols: 100,
        rows: 30
      })
    )
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('replacement authoritative state')
    )
    emitSnapshotFrame(
      latestSubscribePayload().streamId,
      TerminalStreamOpcode.SnapshotEnd,
      new Uint8Array()
    )
    await expect(replacementSnapshot).resolves.toMatchObject({
      data: 'replacement authoritative state',
      cols: 100,
      rows: 30
    })
  })

  it('retries inventory and reattaches the same HUB handle after a stream ends', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onPtyExit = vi.fn()
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('hub-env', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1',
        onPtyExit,
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-stable'
      transport.attach({
        existingPtyId: 'remote:hub-env@@terminal-stable',
        cols: 100,
        rows: 30,
        callbacks: {}
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const oldStreamId = latestSubscribePayload().streamId
      emitSnapshot(oldStreamId, 'before stream end')
      expect(transport.isConnected()).toBe(true)

      let inventoryAvailable = false
      let hostListCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        hostListCalls += 1
        if (!inventoryAvailable) {
          throw new Error('runtime reconnect in progress')
        }
        return readyHostSessionInventoryResponse('terminal-stable')
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: oldStreamId, code: 0 }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      const subscribeCount = (): number =>
        subscriptionSendBinary.mock.calls
          .map((call) => decodeTerminalStreamFrame(call[0]))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe).length
      expect(subscribeCount()).toBe(1)
      expect(hostListCalls).toBeGreaterThan(1)
      expect(hostListCalls).toBeLessThan(25)
      inventoryAvailable = true
      await vi.advanceTimersByTimeAsync(16_000)

      expect(hostListCalls).toBeLessThan(40)
      expect(subscribedTerminalHandles()).toEqual(['terminal-stable', 'terminal-stable'])
      expect(onPtyRebind).not.toHaveBeenCalled()
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-stable')
      expect(transport.isConnected()).toBe(false)

      emitSnapshot(latestSubscribePayload().streamId, 'same handle reattached')
      expect(transport.isConnected()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
