import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../../store/types'
import { getActiveTabNavOrder, getGroupVisibleTabOrder } from './group-tab-order'
import { buildOrderedTabItems } from '@/components/tab-bar/model/tab-bar-item-model'

import { makeOpenFile } from '../../../../store/slices/editor/types/open-file.test-fixture'
import { makeTerminalTab } from '../../../../store/terminals/testing/terminal-row.test-fixture'

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

describe('room tabs', () => {
  const room: Tab = { ...terminalTab('room-tab', 'g1', 'bot-group-1', 1), contentType: 'room' }
  const group: TabGroup = {
    id: 'g1',
    worktreeId: 'wt',
    activeTabId: 'room-tab',
    tabOrder: ['t1', 'room-tab']
  }
  const tabs = [terminalTab('t1', 'g1', 'pty-1', 0), room]

  it('cycle like a chat tab, by their unified tab', () => {
    expect(getGroupVisibleTabOrder(group, tabs, new Set(['pty-1']), new Set(), new Set())).toEqual([
      { type: 'terminal', id: 'pty-1', tabId: 't1' },
      { type: 'agent-session', id: 'bot-group-1', tabId: 'room-tab' }
    ])
  })

  it('show in the strip from the unified tab alone', () => {
    const items = buildOrderedTabItems({
      tabBarOrder: ['pty-1', 'room-tab'],
      terminalIds: ['pty-1'],
      editorFileIds: [],
      browserTabIds: [],
      simulatorTabIds: [],
      roomTabIds: ['room-tab'],
      agentSessionTabIds: [],
      terminalMap: new Map([['pty-1', makeTerminalTab({ id: 'pty-1', worktreeId: 'wt' })]]),
      editorMap: new Map(),
      browserMap: new Map(),
      agentSessionMap: new Map(),
      unifiedTabByVisibleId: new Map([['room-tab', room]])
    })
    expect(items.map((item) => [item.type, item.unifiedTabId])).toEqual([
      ['terminal', 'pty-1'],
      ['room', 'room-tab']
    ])
  })
})
