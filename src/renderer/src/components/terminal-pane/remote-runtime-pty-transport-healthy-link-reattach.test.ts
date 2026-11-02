import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import type { PtyTransport } from './pty-transport-types'

// These transport fixtures never read abandoned-launch ownership from the app store.
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  subscribedTerminalHandles,
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

function hostSnapshot(status: 'pending-handle' | 'ready'): unknown {
  return {
    ok: true,
    result: {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
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
          status,
          terminal: status === 'ready' ? 'terminal-1' : null
        }
      ]
    }
  }
}

function endLatestStream(): void {
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: { type: 'end', streamId: latestSubscribePayload().streamId, code: 0 }
  })
}

// #27178: a remote pane on a healthy link must not sit on "Reconnecting" after a worktree switch.
describe('remote runtime PTY reattach on a healthy link', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function attachHostMirror(): Promise<PtyTransport> {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'initial')
    expect(transport.isConnected()).toBe(true)
    return transport
  }

  it('reattaches a handle the host still reports ready within seconds of a stream end', async () => {
    const transport = await attachHostMirror()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' || args.method === 'session.tabs.activate'
        ? readyHostSessionInventoryResponse('terminal-1')
        : { ok: true, result: {} }
    )

    endLatestStream()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    emitSnapshot(latestSubscribePayload().streamId, 'reattached')
    expect(transport.isConnected()).toBe(true)
    expect(transport.getRecoveryState?.().phase).toBe('connected')
    transport.destroy?.()
  })

  it('keeps reattaching a still-ready handle that ends repeatedly instead of parking', async () => {
    const transport = await attachHostMirror()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' || args.method === 'session.tabs.activate'
        ? readyHostSessionInventoryResponse('terminal-1')
        : { ok: true, result: {} }
    )

    for (let cycle = 0; cycle < 5; cycle += 1) {
      endLatestStream()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(subscribedTerminalHandles()).toHaveLength(cycle + 2)
      emitSnapshot(latestSubscribePayload().streamId, `cycle ${cycle}`)
      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
    }
    transport.destroy?.()
  })

  it('retries a resubscribe whose host answered without a ready handle', async () => {
    const transport = await attachHostMirror()
    let hostReady = false
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' || args.method === 'session.tabs.activate'
        ? hostSnapshot(hostReady ? 'ready' : 'pending-handle')
        : { ok: true, result: {} }
    )

    endLatestStream()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(subscribedTerminalHandles()).toHaveLength(1)
    hostReady = true
    await vi.advanceTimersByTimeAsync(5_000)

    expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    transport.destroy?.()
  })

  it('retries an attach whose host surface stayed pending past the bounded wait', async () => {
    let hostReady = false
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' || args.method === 'session.tabs.activate'
        ? hostSnapshot(hostReady ? 'ready' : 'pending-handle')
        : { ok: true, result: {} }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })

    await vi.advanceTimersByTimeAsync(16_000)
    expect(subscribedTerminalHandles()).toHaveLength(0)
    hostReady = true
    await vi.advanceTimersByTimeAsync(5_000)

    expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
    transport.destroy?.()
  })

  it('retries a resubscribe past repeated inventory failures once the host answers again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const transport = await attachHostMirror()
      let inventoryAvailable = false
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'session.tabs.list' || args.method === 'session.tabs.activate') {
          if (!inventoryAvailable) {
            throw new Error('runtime command response timed out')
          }
          return readyHostSessionInventoryResponse('terminal-1')
        }
        return { ok: true, result: {} }
      })

      endLatestStream()
      await vi.advanceTimersByTimeAsync(50_000)
      expect(subscribedTerminalHandles()).toHaveLength(1)
      inventoryAvailable = true
      await vi.advanceTimersByTimeAsync(35_000)

      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
      transport.destroy?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('still latches a pane whose host never produces a handle', async () => {
    const transport = await attachHostMirror()
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' || args.method === 'session.tabs.activate'
        ? hostSnapshot('pending-handle')
        : { ok: true, result: {} }
    )

    endLatestStream()
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)

    expect(transport.getRecoveryState?.().phase).toBe('disconnected')
    expect(transport.isConnected()).toBe(false)
    expect(transport.retryRecovery?.()).toBe(true)
    transport.destroy?.()
  })
})
