import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../../store/types'
import { getActiveTabNavOrder } from './group-tab-order'

import { makeOpenFile } from '../../store/slices/editor/types/open-file.test-fixture'
import { makeTerminalTab } from '../../store/terminals/testing/terminal-row.test-fixture'

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
  it('keeps the active group editor ref isolated when the same file is open in another group', () => {
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
    const tabs: Tab[] = [
      editorTab('tab-e1', 'g1', '/repo/file.md', 0),
      terminalTab('tab-t1', 'g1', 'term-1', 1),
      editorTab('tab-e2', 'g2', '/repo/file.md', 2),
      terminalTab('tab-t2', 'g2', 'term-2', 3)
    ]
    const state = makeState({
      activeGroupIdByWorktree: { wt: 'g1' },
      groupsByWorktree: { wt: [activeGroup, otherGroup] },
      unifiedTabsByWorktree: { wt: tabs },
      tabsByWorktree: {
        wt: [
          makeTerminalTab({ id: 'term-1', worktreeId: 'wt' }),
          makeTerminalTab({ id: 'term-2', worktreeId: 'wt' })
        ]
      },
      openFiles: [makeOpenFile({ id: '/repo/file.md', worktreeId: 'wt' })]
    })

    expect(getActiveTabNavOrder(state, 'wt')).toEqual([
      { type: 'editor', id: '/repo/file.md', tabId: 'tab-e1' },
      { type: 'terminal', id: 'term-1', tabId: 'tab-t1' }
    ])
  })
})
