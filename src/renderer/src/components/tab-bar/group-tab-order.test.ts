import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../../store/types'
import { getActiveTabNavOrder, getGroupVisibleTabOrder } from './group-tab-order'
import { buildOrderedTabItems } from './tab-bar-item-model'

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

function simulatorTab(id: string, groupId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: 'wt',
    contentType: 'simulator',
    label: 'Mobile Emulator',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function agentSessionTab(id: string, groupId: string, sessionId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: sessionId,
    groupId,
    worktreeId: 'wt',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

describe('getGroupVisibleTabOrder', () => {
  it('includes structured sessions without a terminal backing entity', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-a1',
      tabOrder: ['tab-t1', 'tab-a1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      agentSessionTab('tab-a1', 'g1', 'session-1', 1)
    ]
    expect(getGroupVisibleTabOrder(group, tabs, new Set(['term-1']), new Set(), new Set())).toEqual(
      [
        { type: 'terminal', id: 'term-1', tabId: 'tab-t1' },
        { type: 'agent-session', id: 'session-1', tabId: 'tab-a1' }
      ]
    )
  })

  it('returns active-group refs with backing ids plus unified tab ids', () => {
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
      { type: 'terminal', id: 'term-1', tabId: 'tab-t1' },
      { type: 'editor', id: '/repo/file.md', tabId: 'tab-e1' },
      { type: 'terminal', id: 'term-2', tabId: 'tab-t2' }
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
      [{ type: 'terminal', id: 'term-1', tabId: 'tab-t1' }]
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
      { type: 'terminal', id: 'term-1', tabId: 'tab-t1' },
      { type: 'browser', id: 'browser-1', tabId: 'tab-b1' },
      { type: 'editor', id: '/repo/file.md', tabId: 'tab-e1' }
    ])
  })

  it('includes simulator tabs keyed by unified tab id in the declared group order', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-s1',
      tabOrder: ['tab-t1', 'tab-s1', 'tab-e1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      simulatorTab('tab-s1', 'g1', 1),
      editorTab('tab-e1', 'g1', '/repo/file.md', 2)
    ]
    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['term-1']),
        new Set(['/repo/file.md']),
        new Set(),
        new Set(['tab-s1'])
      )
    ).toEqual([
      { type: 'terminal', id: 'term-1', tabId: 'tab-t1' },
      { type: 'simulator', id: 'tab-s1', tabId: 'tab-s1' },
      { type: 'editor', id: '/repo/file.md', tabId: 'tab-e1' }
    ])
  })

  it('matches the strip lookup when duplicate entities resolve to the last tab copy', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t2',
      tabOrder: ['tab-t1', 'tab-t2']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-1', 1)
    ]

    expect(getGroupVisibleTabOrder(group, tabs, new Set(['term-1']), new Set(), new Set())).toEqual(
      [{ type: 'terminal', id: 'term-1', tabId: 'tab-t2' }]
    )
  })

  it('uses terminal precedence when visible ids collide across content types', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      tabOrder: ['tab-b1', 'tab-t1']
    }
    const tabs: Tab[] = [
      browserTab('tab-b1', 'g1', 'collision', 0),
      terminalTab('tab-t1', 'g1', 'collision', 1)
    ]

    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['collision']),
        new Set(),
        new Set(['collision'])
      )
    ).toEqual([{ type: 'terminal', id: 'collision', tabId: 'tab-t1' }])
  })

  it('can preserve cross-type ids for mobile publication compatibility', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-b1',
      tabOrder: ['tab-b1', 'tab-t1']
    }
    const tabs: Tab[] = [
      browserTab('tab-b1', 'g1', 'collision', 0),
      terminalTab('tab-t1', 'g1', 'collision', 1)
    ]

    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['collision']),
        new Set(),
        new Set(['collision']),
        new Set(),
        true
      )
    ).toEqual([
      { type: 'browser', id: 'collision', tabId: 'tab-b1' },
      { type: 'terminal', id: 'collision', tabId: 'tab-t1' }
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
        // @ts-expect-error — minimal shape for terminal presence only
        wt: [{ id: 'term-1' }, { id: 'term-2' }]
      },
      openFiles: [
        // @ts-expect-error — minimal OpenFile shape; nav helper only reads `id` and `worktreeId`
        { id: '/repo/file.md', worktreeId: 'wt' }
      ]
    })

    expect(getActiveTabNavOrder(state, 'wt')).toEqual([
      { type: 'editor', id: '/repo/file.md', tabId: 'tab-e1' },
      { type: 'terminal', id: 'term-1', tabId: 'tab-t1' }
    ])
  })

  it('falls back to the legacy reconciled order when no active group exists', () => {
    const state = makeState({
      tabBarOrderByWorktree: { wt: ['term-1', 'sim-1', 'e1', 'term-2'] },
      unifiedTabsByWorktree: { wt: [simulatorTab('sim-1', 'g1', 3)] },
      tabsByWorktree: {
        // @ts-expect-error — minimal shape
        wt: [{ id: 'term-1' }, { id: 'term-2' }]
      },
      // @ts-expect-error — minimal shape
      openFiles: [{ id: 'e1', worktreeId: 'wt' }]
    })
    expect(getActiveTabNavOrder(state, 'wt')).toEqual([
      { type: 'terminal', id: 'term-1' },
      { type: 'simulator', id: 'sim-1' },
      { type: 'editor', id: 'e1' },
      { type: 'terminal', id: 'term-2' }
    ])
  })
})

// The keyboard cycle must match the rendered strip; reconcileTabOrder appends missing group tabs.
describe('group order matches the rendered tab strip', () => {
  function renderedStripIds(group: TabGroup, tabs: Tab[]): string[] {
    const groupTabs = tabs.filter((tab) => tab.groupId === group.id)
    const tabBarOrder = group.tabOrder.map((tabId) => {
      const tab = groupTabs.find((candidate) => candidate.id === tabId)
      if (!tab) {
        return tabId
      }
      return tab.contentType === 'terminal' || tab.contentType === 'browser' ? tab.entityId : tab.id
    })
    const terminalMap = new Map(
      groupTabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => [tab.entityId, { id: tab.entityId, unifiedTabId: tab.id }])
    )
    return buildOrderedTabItems({
      tabBarOrder,
      terminalIds: groupTabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => tab.entityId),
      editorFileIds: [],
      browserTabIds: [],
      simulatorTabIds: [],
      agentSessionTabIds: [],
      terminalMap: terminalMap as never,
      editorMap: new Map(),
      browserMap: new Map(),
      agentSessionMap: new Map(),
      unifiedTabByVisibleId: new Map()
    }).map((item) => item.id)
  }

  it('cycles a tab that hydrated into the group before group.tabOrder learned about it', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      // Hydration race: tab-t2 is in the group but not yet in the persisted order.
      tabOrder: ['tab-t1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-2', 1)
    ]

    expect(renderedStripIds(group, tabs)).toEqual(['term-1', 'term-2'])
    expect(
      getGroupVisibleTabOrder(group, tabs, new Set(['term-1', 'term-2']), new Set(), new Set()).map(
        (entry) => entry.id
      )
    ).toEqual(['term-1', 'term-2'])
  })

  it('keeps drag-reordered positions and appends only the unknown tail', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t2',
      tabOrder: ['tab-t3', 'tab-t2'],
      recentTabIds: []
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      terminalTab('tab-t2', 'g1', 'term-2', 1),
      terminalTab('tab-t3', 'g1', 'term-3', 2)
    ]

    expect(renderedStripIds(group, tabs)).toEqual(['term-3', 'term-2', 'term-1'])
    expect(
      getGroupVisibleTabOrder(
        group,
        tabs,
        new Set(['term-1', 'term-2', 'term-3']),
        new Set(),
        new Set()
      ).map((entry) => entry.id)
    ).toEqual(['term-3', 'term-2', 'term-1'])
  })

  it('still drops tabs whose backing entity is gone, exactly as the strip does', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt',
      activeTabId: 'tab-t1',
      tabOrder: ['tab-t1']
    }
    const tabs: Tab[] = [
      terminalTab('tab-t1', 'g1', 'term-1', 0),
      editorTab('tab-e1', 'g1', '/repo/closed.md', 1)
    ]

    expect(
      getGroupVisibleTabOrder(group, tabs, new Set(['term-1']), new Set(), new Set()).map(
        (entry) => entry.id
      )
    ).toEqual(['term-1'])
  })
})
