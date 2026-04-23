import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/types'
import type { AppState } from '../../store/types'
import { getActiveTabNavOrder, getGroupVisibleTabOrder } from './group-tab-order'

function terminalTab(id: string, groupId: string, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: 'wt',
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function editorTab(id: string, groupId: string, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: 'wt',
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function browserTab(id: string, groupId: string, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: 'wt',
    contentType: 'browser',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

describe('getGroupVisibleTabOrder', () => {
  it('returns terminal/browser tabs keyed by entityId and editor tabs keyed by unified id', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      tabOrder: ['tab-t1', 'tab-e1', 'tab-t2']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      editorTab('tab-e1', 'g1', '/repo/file.md', 1),
      terminalTab('tab-t2', 'g1', 'term-2', 2)
    ]
    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['term-1', 'term-2']),
        new Set(['/repo/file.md']),
        new Set()
      )
    ).toEqual([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'tab-e1' },
      { type: 'terminal', id: 'term-2' }
    ])
  })

  it('walks tabs in the reordered group.tabOrder sequence (regression: drag-reordered tabs)', () => {
    // Original visual order was [term-1, term-2, term-3]; user dragged
    // term-1 to the end so tabOrder is now [tab-t2, tab-t3, tab-t1]. The
    // pre-fix keyboard nav read the stale tabBarOrderByWorktree and cycled
    // 3 → 1 → 2 instead of 3 → 2 → 1. This walks the new canonical order.
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      tabOrder: ['tab-t2', 'tab-t3', 'tab-t1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-2', 1),
      terminalTab('tab-t3', 'g1', 'term-3', 2)
    ]
    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['term-1', 'term-2', 'term-3']),
        new Set(),
        new Set()
      ).map((t) => t.id)
    ).toEqual(['term-2', 'term-3', 'term-1'])
  })

  it('skips tabs whose backing entity is not present', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      tabOrder: ['tab-t1', 'tab-t2']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-zombie', 1)
    ]
    expect(getGroupVisibleTabOrder(group, tabs, new Set(['term-1']), new Set(), new Set())).toEqual(
      [{ type: 'terminal', id: 'term-1' }]
    )
  })

  it('includes browser tabs keyed by entityId in the declared group order', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-b1',
      tabOrder: ['tab-t1', 'tab-b1', 'tab-e1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      browserTab('tab-b1', 'g1', 'browser-1', 1),
      editorTab('tab-e1', 'g1', '/repo/file.md', 2)
    ]
    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['term-1']),
        new Set(['/repo/file.md']),
        new Set(['browser-1'])
      )
    ).toEqual([
      { type: 'terminal', id: 'term-1' },
      { type: 'browser', id: 'browser-1' },
      { type: 'editor', id: 'tab-e1' }
    ])
  })
})

type NavState = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'groupsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'openFiles'
  | 'browserTabsByWorktree'
>

function makeState(overrides: Partial<NavState>): NavState {
  return {
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    ...overrides
  }
}

describe('getActiveTabNavOrder', () => {
  it('uses the active group order and ignores the stale legacy order after drag-reorder', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      // Drag-reordered: canonical order is [t2, t3, t1]
      tabOrder: ['tab-t2', 'tab-t3', 'tab-t1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-2', 1),
      terminalTab('tab-t3', 'g1', 'term-3', 2)
    ]
    const state = makeState({
      activeGroupIdByWorktree: { wt: 'g1' },
      groupsByWorktree: { wt: [group] },
      unifiedTabsByWorktree: { wt: tabs },
      // Stale legacy order still in insertion order:
      tabBarOrderByWorktree: { wt: ['term-1', 'term-2', 'term-3'] },
      tabsByWorktree: {
        // @ts-expect-error — minimal TerminalTab shape; nav helper only reads `id`
        wt: [{ id: 'term-1' }, { id: 'term-2' }, { id: 'term-3' }]
      }
    })
    expect(getActiveTabNavOrder(state, 'wt').map((t) => t.id)).toEqual([
      'term-2',
      'term-3',
      'term-1'
    ])
  })

  it('falls back to the legacy reconciled order when no active group exists', () => {
    const state = makeState({
      tabBarOrderByWorktree: { wt: ['term-1', 'e1', 'term-2'] },
      tabsByWorktree: {
        // @ts-expect-error — minimal shape
        wt: [{ id: 'term-1' }, { id: 'term-2' }]
      },
      // @ts-expect-error — minimal shape
      openFiles: [{ id: 'e1', worktreeId: 'wt' }]
    })
    expect(getActiveTabNavOrder(state, 'wt')).toEqual([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'e1' },
      { type: 'terminal', id: 'term-2' }
    ])
  })
})
