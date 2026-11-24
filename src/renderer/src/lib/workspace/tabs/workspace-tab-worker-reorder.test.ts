// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { moveActiveTab } from './workspace-tab-commands'

vi.mock('@/runtime/workspace-layout/commands/tab-group-layout-owner-commands', () => ({
  reorderTabInGroup: (_worktreeId: string, command: { groupId: string; tabOrder: string[] }) => {
    useAppStore.getState().reorderUnifiedTabs(command.groupId, command.tabOrder)
    return false
  }
}))
beforeEach(() => {
  useAppStore.setState({
    activeGroupIdByWorktree: { wt: 'group' },
    groupsByWorktree: {
      wt: [
        makeTabGroup({
          id: 'group',
          worktreeId: 'wt',
          activeTabId: 'first',
          tabOrder: ['first', 'folded', 'last']
        })
      ]
    },
    unifiedTabsByWorktree: {
      wt: ['first', 'folded', 'last'].map((id) =>
        makeUnifiedTab({
          id,
          worktreeId: 'wt',
          groupId: 'group',
          ...(id === 'folded'
            ? {
                workerTab: {
                  origin: {
                    runId: 'run',
                    dispatchId: 'dispatch',
                    taskId: 'task',
                    workerLeafId: '00000000-0000-4000-8000-000000000001',
                    parent: { kind: 'pane', paneKey: 'first:leaf' },
                    coordinator: { kind: 'pane', paneKey: 'first:leaf' }
                  }
                }
              }
            : {})
        })
      )
    },
    workerTabsMode: 'open-when-clicked',
    workerTabStripChoiceByWorktree: { wt: { folded: 'hidden' } },
    workerTabPeekByGroupId: {}
  })
})
it('moves across a folded neighbor to the next visible tab while preserving the worker', () => {
  expect(moveActiveTab('wt', 1)).toBe(true)
  expect(useAppStore.getState().groupsByWorktree.wt?.[0]?.tabOrder).toEqual([
    'folded',
    'last',
    'first'
  ])
  expect(useAppStore.getState().unifiedTabsByWorktree.wt?.map((tab) => tab.id)).toEqual([
    'first',
    'folded',
    'last'
  ])
})
