import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'
import type { TabsDrawnFromMain } from '../slices/tabs/tabs-drawn-from-main.test-fixture'

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
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = createStoreCascadesMockApi()

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

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
})
