// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  republishMobileSessionWorktree: vi.fn(),
  replyGraphResync: vi.fn(),
  resyncListener: null as ((data: { requestId: string; worktreeId: string }) => void) | null
}))

vi.mock('@/runtime/sync-runtime-graph/graph-publication', () => ({
  republishMobileSessionWorktree: mocks.republishMobileSessionWorktree
}))
vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))
vi.mock('../../store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))
vi.mock('../../store/pinned-tab-close-guard', () => ({
  guardPinnedTabClose: vi.fn(),
  isUnifiedTabPinned: vi.fn(),
  resolvePinnedTabLabel: vi.fn()
}))

import { registerBrowserRequestIpcBridge } from './browser-request-ipc-bridge'

describe('browser graph-resync bridge', () => {
  beforeEach(() => {
    mocks.republishMobileSessionWorktree.mockReset().mockResolvedValue(true)
    mocks.replyGraphResync.mockReset()
    mocks.resyncListener = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRequestTabCreate: () => () => {},
          replyTabCreate: vi.fn(),
          onRequestGraphResync: (listener: typeof mocks.resyncListener) => {
            mocks.resyncListener = listener
            return () => {}
          },
          replyGraphResync: mocks.replyGraphResync,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: vi.fn(),
          onRequestTabClose: () => () => {},
          replyTabClose: vi.fn()
        }
      }
    })
  })

  it('replies only after the republish settles, so main never reads a stale snapshot', async () => {
    // Hold the republish open: main must not be told the graph is ready until
    // syncRuntimeGraph has actually committed the worktree's snapshot.
    let resolveRepublish: (ok: boolean) => void = () => {}
    mocks.republishMobileSessionWorktree.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRepublish = resolve
      })
    )
    registerBrowserRequestIpcBridge([], () => false)

    mocks.resyncListener?.({ requestId: 'resync-1', worktreeId: 'wt-1' })

    expect(mocks.republishMobileSessionWorktree).toHaveBeenCalledExactlyOnceWith('wt-1')
    // No reply while the republish is still in flight.
    await Promise.resolve()
    expect(mocks.replyGraphResync).not.toHaveBeenCalled()

    resolveRepublish(true)

    await vi.waitFor(() =>
      expect(mocks.replyGraphResync).toHaveBeenCalledExactlyOnceWith({ requestId: 'resync-1', ok: true })
    )
  })

  it('replies ok:false when the republish fails so the list never hangs and the resync stays retryable', async () => {
    mocks.republishMobileSessionWorktree.mockRejectedValue(new Error('sync failed'))
    registerBrowserRequestIpcBridge([], () => false)

    mocks.resyncListener?.({ requestId: 'resync-2', worktreeId: 'wt-2' })

    await vi.waitFor(() =>
      expect(mocks.replyGraphResync).toHaveBeenCalledExactlyOnceWith({ requestId: 'resync-2', ok: false })
    )
  })
})
