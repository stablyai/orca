import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = createStoreCascadesMockApi()

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

/** Every change is drawn once this resolves; at once with the switch off. */
async function settled(): Promise<void> {
  await main?.settle()
}

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('returns to the landing state when closing the last terminal tab in the active worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const tabId = 'tab-1'
    const unifiedTabId = 'unified-tab-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabId: tabId,
      activeTabType: 'terminal',
      activeTabIdByWorktree: { [wt]: tabId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: tabId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: unifiedTabId,
            entityId: tabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal',
            label: 'Terminal 1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: unifiedTabId,
            tabOrder: [unifiedTabId]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      }
    })

    store.getState().closeTab(tabId)

    const s = store.getState()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.tabsByWorktree[wt]).toEqual([])
    expect(s.unifiedTabsByWorktree[wt]).toEqual([])
  })

  it('does not switch the global surface when creating a browser tab for a background worktree', async () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })
    main = await drawTabsFromMain(store)

    const browserTab = store
      .getState()
      .createBrowserTab(backgroundWt, 'https://example.com', { activate: true })
    await settled()

    const s = store.getState()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[backgroundWt]).toBe('browser')
    expect(s.activeBrowserTabIdByWorktree[backgroundWt]).toBe(browserTab.id)
  })

  it('uses unified MRU selection when closing an active browser tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })
    main = await drawTabsFromMain(store)

    const previous = store.getState().createBrowserTab(wt, 'https://previous.example.com')
    await settled()
    store.getState().createBrowserTab(wt, 'https://neighbor.example.com')
    await settled()
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')
    await settled()
    store.getState().setActiveBrowserTab(previous.id)
    await settled()
    store.getState().setActiveBrowserTab(closing.id)
    await settled()

    store.getState().closeBrowserTab(closing.id)
    await settled()

    expect(store.getState().activeBrowserTabId).toBe(previous.id)
    expect(store.getState().activeBrowserTabIdByWorktree[wt]).toBe(previous.id)
  })

  it('keeps the unified MRU target when closing the last browser tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })
    main = await drawTabsFromMain(store)

    store.getState().createTab(wt)
    await settled()
    const previous = store.getState().createTab(wt)
    await settled()
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')
    await settled()

    store.getState().closeBrowserTab(closing.id)
    await settled()

    expect(store.getState().activeTabId).toBe(previous.id)
    expect(store.getState().activeTabType).toBe('terminal')
  })
})
