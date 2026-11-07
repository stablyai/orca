import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import type { AppState } from '../../store/types'
import type { Tab } from '../../../../shared/tab-types'
import { buildRecentTabSwitcherModel } from './recent-tab-switching'

const WT = 'wt-1'
const GROUP = 'group-1'

function tab(id: string, entityId: string, label: string): Tab {
  return {
    id,
    entityId,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'editor',
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function stateWithTabs(
  tabOrder: string[],
  recentTabIds: string[],
  activeTabId: string,
  hydratingTabIds: string[] = []
): AppState {
  // Include only actual group tabs; extra tabs absent from tabOrder would be appended by strip reconciliation.
  const tabs = [
    tab('tab-a', 'file-a', 'A'),
    tab('tab-b', 'file-b', 'B'),
    tab('tab-c', 'file-c', 'C')
  ].filter((entry) => tabOrder.includes(entry.id) || hydratingTabIds.includes(entry.id))
  return {
    ...createTestStore().getState(),
    activeBrowserTabId: null,
    activeFileId: tabs.find((entry) => entry.id === activeTabId)?.entityId ?? null,
    activeGroupIdByWorktree: { [WT]: GROUP },
    activeTabId: null,
    activeTabType: 'editor',
    browserTabsByWorktree: {},
    groupsByWorktree: {
      [WT]: [{ id: GROUP, worktreeId: WT, activeTabId, tabOrder, recentTabIds }]
    },
    openFiles: tabs.map((entry) => ({
      id: entry.entityId,
      worktreeId: WT
    })) as AppState['openFiles'],
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: { [WT]: tabs }
  }
}

describe('buildRecentTabSwitcherModel', () => {
  it('orders tabs by MRU with the active tab first', () => {
    const model = buildRecentTabSwitcherModel(
      stateWithTabs(['tab-a', 'tab-b', 'tab-c'], ['tab-a', 'tab-c', 'tab-b'], 'tab-b'),
      WT,
      'mru'
    )

    expect(model?.items.map((item) => item.label)).toEqual(['B', 'C', 'A'])
    expect(model?.activeIndex).toBe(0)
  })

  it('includes a unified tab that has not yet entered persisted group order', () => {
    const model = buildRecentTabSwitcherModel(
      stateWithTabs(['tab-a'], [], 'tab-a', ['tab-b']),
      WT,
      'sequential'
    )

    expect(model?.items.map((item) => item.label)).toEqual(['A', 'B'])
    expect(model?.activeIndex).toBe(0)
  })
})
