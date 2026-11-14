import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeTab } from '../../../terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../../tabs/tab-group.test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import '../../../terminals/retirement/terminal-orphan-cleanup'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

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

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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

  it('promotes the next tab in the focused split into the global active surface on close', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const browserTabId = 'browser-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      activeBrowserTabId: browserTabId,
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'browser-view-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser',
            label: 'Example'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'browser-view-1',
            tabOrder: [terminalTabId, 'browser-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })
    main = await drawTabsFromMain(store)

    store.getState().closeBrowserTab(browserTabId)
    await main.settle()

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(terminalTabId)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalTabId)
    expect(s.activeBrowserTabId).toBeNull()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeNull()
  })
})
