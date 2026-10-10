import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store'
import type { Tab } from '../../../../shared/tab-types'
import {
  TAB_SPLIT_SHORTCUT_DIRECTIONS,
  resolveActiveTabPaneColumnTarget,
  resolveBrowserSourcePaneColumnTarget
} from './active-tab-pane-column-split'

const WT = 'wt-1'

function unifiedTab(id: string, sortOrder: number): Tab {
  return {
    id,
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    entityId: `term-${id}`,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

describe('active-tab-pane-column-split', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorktreeId: WT,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a', 'tab-b']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [unifiedTab('tab-a', 0), unifiedTab('tab-b', 1)]
      },
      layoutByWorktree: {
        [WT]: { type: 'leaf', groupId: 'group-1' }
      }
    })
  })

  it('maps each split shortcut to its pane column direction', () => {
    expect(TAB_SPLIT_SHORTCUT_DIRECTIONS).toEqual([['tab.moveToSplitRight', 'right']])
  })

  it('resolves the active tab and its group for the active worktree', () => {
    expect(resolveActiveTabPaneColumnTarget(WT)).toEqual({
      unifiedTabId: 'tab-a',
      groupId: 'group-1'
    })
  })

  it('returns null without a worktree', () => {
    expect(resolveActiveTabPaneColumnTarget(null)).toBeNull()
    expect(resolveActiveTabPaneColumnTarget(undefined)).toBeNull()
  })

  it('returns null for an unknown worktree', () => {
    expect(resolveActiveTabPaneColumnTarget('wt-missing')).toBeNull()
  })

  it('returns null when the active group has a single tab', () => {
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a']
          }
        ]
      },
      unifiedTabsByWorktree: { [WT]: [unifiedTab('tab-a', 0)] }
    })

    expect(resolveActiveTabPaneColumnTarget(WT)).toBeNull()
  })

  it('returns null when the active group has no active tab', () => {
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: null,
            tabOrder: ['tab-a', 'tab-b']
          }
        ]
      }
    })

    expect(resolveActiveTabPaneColumnTarget(WT)).toBeNull()
  })

  describe('resolveBrowserSourcePaneColumnTarget', () => {
    function seedBrowserInSecondGroup(tabOrder: string[]): void {
      const browserTab: Tab = {
        ...unifiedTab('tab-browser', 2),
        groupId: 'group-2',
        contentType: 'browser',
        entityId: 'ws-1'
      }
      useAppStore.setState({
        groupsByWorktree: {
          [WT]: [
            { id: 'group-1', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'] },
            { id: 'group-2', worktreeId: WT, activeTabId: 'tab-browser', tabOrder }
          ]
        },
        unifiedTabsByWorktree: {
          [WT]: [unifiedTab('tab-a', 0), unifiedTab('tab-b', 1), browserTab]
        },
        browserTabsByWorktree: { [WT]: [{ id: 'ws-1' }] },
        browserPagesByWorkspace: { 'ws-1': [{ id: 'page-1' }] }
      } as unknown as Parameters<typeof useAppStore.setState>[0])
    }

    it('targets the guest-owning tab even when another group is active', () => {
      seedBrowserInSecondGroup(['tab-browser', 'tab-other'])

      expect(resolveBrowserSourcePaneColumnTarget('page-1')).toEqual({
        unifiedTabId: 'tab-browser',
        groupId: 'group-2'
      })
    })

    it('returns null for an unknown guest or a single-tab group', () => {
      seedBrowserInSecondGroup(['tab-browser', 'tab-other'])
      expect(resolveBrowserSourcePaneColumnTarget('page-missing')).toBeNull()

      seedBrowserInSecondGroup(['tab-browser'])
      expect(resolveBrowserSourcePaneColumnTarget('page-1')).toBeNull()
    })
  })
})
