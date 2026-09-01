import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../../store/types'
import { resolveTabCloseScopeTargets } from './tab-close-scope-targets'

type ScopeState = Parameters<typeof resolveTabCloseScopeTargets>[0]

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

function makeState(overrides: Partial<ScopeState>): ScopeState {
  return {
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeTabType: 'terminal',
    activeTabId: null,
    activeFileId: null,
    activeBrowserTabId: null,
    ...overrides
  } as ScopeState
}

const THREE_TERMINALS = {
  tabsByWorktree: {
    wt: [{ id: 'term-1' }, { id: 'term-2' }, { id: 'term-3' }]
  } as unknown as AppState['tabsByWorktree']
}

describe('resolveTabCloseScopeTargets', () => {
  describe('with a split-group layout', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      // Drag-reordered: the strip shows term-2 first, so term-1 is no longer leftmost.
      tabOrder: ['tab-t2', 'tab-t1', 'tab-t3']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-2', 1),
      terminalTab('tab-t3', 'g1', 'term-3', 2)
    ]
    const state = makeState({
      ...THREE_TERMINALS,
      activeGroupIdByWorktree: { wt: 'g1' },
      groupsByWorktree: { wt: [group] },
      unifiedTabsByWorktree: { wt: tabs },
      // Stale legacy order: it must not decide what gets closed.
      tabBarOrderByWorktree: { wt: ['term-1', 'term-2', 'term-3'] },
      activeTabId: 'term-1'
    })

    it('targets every sibling for a close-others', () => {
      expect(resolveTabCloseScopeTargets(state, 'wt', 'others')).toEqual(['term-2', 'term-3'])
    })

    it('walks the drag-reordered strip order for directional closes', () => {
      // The stale legacy order would leave nothing to the left of term-1.
      expect(resolveTabCloseScopeTargets(state, 'wt', 'left')).toEqual(['term-2'])
      expect(resolveTabCloseScopeTargets(state, 'wt', 'right')).toEqual(['term-3'])
    })
  })

  it('disambiguates split copies of one file by the active group tab id', () => {
    const activeGroup: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-e1',
      tabOrder: ['tab-e1', 'tab-t1']
    }
    const otherGroup: TabGroup = {
      id: 'g2',
      worktreeId: 'wt',
      activeTabId: 'tab-e2',
      tabOrder: ['tab-e2', 'tab-t2']
    }
    const state = makeState({
      activeGroupIdByWorktree: { wt: 'g1' },
      groupsByWorktree: { wt: [activeGroup, otherGroup] },
      unifiedTabsByWorktree: {
        wt: [
          editorTab('tab-e1', 'g1', '/repo/file.md', 0),
          terminalTab('tab-t1', 'g1', 'term-1', 1),
          editorTab('tab-e2', 'g2', '/repo/file.md', 2),
          terminalTab('tab-t2', 'g2', 'term-2', 3)
        ]
      },
      tabsByWorktree: {
        wt: [{ id: 'term-1' }, { id: 'term-2' }]
      } as unknown as AppState['tabsByWorktree'],
      openFiles: [{ id: '/repo/file.md', worktreeId: 'wt' }] as unknown as AppState['openFiles'],
      activeTabType: 'editor',
      activeFileId: '/repo/file.md'
    })

    // The other group's terminal is never a target: only the active strip is in scope.
    expect(resolveTabCloseScopeTargets(state, 'wt', 'others')).toEqual(['term-1'])
  })

  it('falls back to the legacy worktree order when no group has hydrated', () => {
    const state = makeState({
      ...THREE_TERMINALS,
      tabBarOrderByWorktree: { wt: ['term-1', 'term-2', 'term-3'] },
      activeTabId: 'term-2'
    })

    expect(resolveTabCloseScopeTargets(state, 'wt', 'left')).toEqual(['term-1'])
    expect(resolveTabCloseScopeTargets(state, 'wt', 'right')).toEqual(['term-3'])
    expect(resolveTabCloseScopeTargets(state, 'wt', 'others')).toEqual(['term-1', 'term-3'])
  })

  it('closes nothing when the focused tab is not in the visible order', () => {
    const state = makeState({
      ...THREE_TERMINALS,
      tabBarOrderByWorktree: { wt: ['term-1', 'term-2', 'term-3'] },
      activeTabId: 'term-gone'
    })

    expect(resolveTabCloseScopeTargets(state, 'wt', 'others')).toEqual([])
    expect(resolveTabCloseScopeTargets(state, 'wt', 'right')).toEqual([])
  })
})
