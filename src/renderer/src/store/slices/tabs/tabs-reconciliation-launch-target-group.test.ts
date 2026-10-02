import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createTestStore } from '../store-test-helpers'
import { reserveAgentLaunchTab } from '@/lib/agent-launch-tab-reservations'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'
const releases: (() => void)[] = []

/** A workspace with one live terminal in `g-1` and an empty split `g-2` the user focused. */
function workspaceWithEmptyFocusedSplit(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    tabsByWorktree: {
      [WT]: [
        {
          id: 'term-1',
          ptyId: 'pty-1',
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'term-1': ['pty-1'] },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'term-1',
          entityId: 'term-1',
          groupId: 'g-1',
          worktreeId: WT,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [WT]: [
        { id: 'g-1', worktreeId: WT, activeTabId: 'term-1', tabOrder: ['term-1'] },
        { id: 'g-2', worktreeId: WT, activeTabId: null, tabOrder: [] }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'g-2' }
  })
}

function groupIds(store: ReturnType<typeof createTestStore>): string[] {
  return (store.getState().groupsByWorktree[WT] ?? []).map((group) => group.id)
}

describe('reconciling a workspace while a launch is on its way to an empty group', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    workspaceWithEmptyFocusedSplit(store)
  })
  afterEach(() => {
    releases.splice(0).forEach((release) => release())
  })

  it('drops an empty group nobody is launching into, as before', () => {
    store.getState().reconcileWorktreeTabModel(WT)

    expect(groupIds(store)).toEqual(['g-1'])
  })

  it('keeps the empty group a button launched from until the launch’s tab arrives', () => {
    releases.push(reserveAgentLaunchTab('tab-new', { worktreeId: WT, groupId: 'g-2' }))

    store.getState().reconcileWorktreeTabModel(WT)

    expect(groupIds(store)).toEqual(['g-1', 'g-2'])
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe('g-2')
  })

  it('lets the group go once the launch settles without a tab', () => {
    const release = reserveAgentLaunchTab('tab-new', { worktreeId: WT, groupId: 'g-2' })
    store.getState().reconcileWorktreeTabModel(WT)

    release()
    store.getState().reconcileWorktreeTabModel(WT)

    expect(groupIds(store)).toEqual(['g-1'])
  })
})
