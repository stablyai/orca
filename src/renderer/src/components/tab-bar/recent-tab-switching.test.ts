import { describe, expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import type { Tab } from '../../../../shared/types'
import {
  buildRecentTabSwitcherModel,
  getNextRecentTabSwitcherIndex,
  normalizeCtrlTabOrderMode
} from './recent-tab-switching'

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
  activeTabId: string
): Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeFileId'
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabType'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
> {
  const tabs = [
    tab('tab-a', 'file-a', 'A'),
    tab('tab-b', 'file-b', 'B'),
    tab('tab-c', 'file-c', 'C')
  ]
  return {
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

  it('appends never-visited tabs after the MRU entries in visual order', () => {
    const model = buildRecentTabSwitcherModel(
      stateWithTabs(['tab-a', 'tab-b', 'tab-c'], ['tab-a', 'tab-b'], 'tab-b'),
      WT,
      'mru'
    )

    expect(model?.items.map((item) => item.label)).toEqual(['B', 'A', 'C'])
  })

  it('can use sequential tab-strip order instead of MRU order', () => {
    const model = buildRecentTabSwitcherModel(
      stateWithTabs(['tab-a', 'tab-b', 'tab-c'], ['tab-a', 'tab-c', 'tab-b'], 'tab-b'),
      WT,
      'sequential'
    )

    expect(model?.items.map((item) => item.label)).toEqual(['A', 'B', 'C'])
    expect(model?.activeIndex).toBe(1)
  })

  it('returns null when there is no other tab to switch to', () => {
    const model = buildRecentTabSwitcherModel(
      stateWithTabs(['tab-a'], ['tab-a'], 'tab-a'),
      WT,
      'mru'
    )

    expect(model).toBeNull()
  })
})

describe('getNextRecentTabSwitcherIndex', () => {
  it('wraps in both directions', () => {
    expect(getNextRecentTabSwitcherIndex(3, 0, 1)).toBe(1)
    expect(getNextRecentTabSwitcherIndex(3, 0, -1)).toBe(2)
    expect(getNextRecentTabSwitcherIndex(3, 2, 1)).toBe(0)
  })
})

describe('normalizeCtrlTabOrderMode', () => {
  it('defaults unknown and absent values to MRU', () => {
    expect(normalizeCtrlTabOrderMode(undefined)).toBe('mru')
    expect(normalizeCtrlTabOrderMode(null)).toBe('mru')
    expect(normalizeCtrlTabOrderMode('sequential')).toBe('sequential')
  })
})
