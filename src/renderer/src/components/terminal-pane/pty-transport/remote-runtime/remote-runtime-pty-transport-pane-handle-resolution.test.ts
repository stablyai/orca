import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
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

  it('re-derives the host session handle after a transport close instead of resubscribing the stale one', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getAllOverrides, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const { getAllDrivers, setDriverForPty } =
      await import('@/lib/pane-manager/mobile-driver-state')
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-1' })
    setFitOverride('remote:env-1@@terminal-1', 'mobile-fit', 49, 20)
    setDriverForPty('remote:env-1@@terminal-1', { kind: 'mobile', clientId: 'phone-1' })

    // Re-derive host handles after transport loss; stale closure handles may now name a different PTY (#7718).
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-1',
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
                  terminal: 'terminal-2'
                }
              ]
            }
          }
        : { ok: true, result: {} }
    )
    const subscribeCallsBefore = runtimeSubscribe.mock.calls.length

    // The dedicated multiplex socket dies (liveness/close) → onTransportClose.
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() =>
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBefore)
    )
    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
    )
    expect(transport.getPtyId()).toContain('terminal-2')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyRebind).toHaveBeenCalledWith(
      expect.stringContaining('terminal-2'),
      expect.stringContaining('terminal-1')
    )
    expect([...getAllOverrides().keys()]).toEqual(['remote:env-1@@terminal-2'])
    expect([...getAllDrivers().keys()]).toEqual(['remote:env-1@@terminal-2'])
  })
})
