// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab, TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  focusTerminalPaneAcrossTabs,
  resolveTerminalPaneTabTarget
} from './terminal-pane-tab-navigation'

const getState = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

type NavigationState = Parameters<typeof resolveTerminalPaneTabTarget>[0]['state']
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

function terminal(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'workspace',
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function tab(entityId: string, groupId = 'group'): Tab {
  return {
    id: `unified-${entityId}`,
    entityId,
    worktreeId: 'workspace',
    groupId,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function tree(...leaves: string[]): TerminalPaneLayoutNode | null {
  const [first, ...rest] = leaves
  if (!first) {
    return null
  }
  if (rest.length === 0) {
    return { type: 'leaf', leafId: first }
  }
  const second = tree(...rest)
  if (!second) {
    throw new Error('Expected second subtree')
  }
  return { type: 'split', direction: 'vertical', first: { type: 'leaf', leafId: first }, second }
}

function state(overrides: Partial<NavigationState> = {}): NavigationState {
  return {
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: { workspace: ['first', 'second', 'third'] },
    tabsByWorktree: { workspace: [terminal('first'), terminal('second'), terminal('third')] },
    openFiles: [],
    browserTabsByWorktree: {},
    terminalLayoutsByTabId: {
      first: { root: tree(LEAF_A, LEAF_B), activeLeafId: LEAF_A, expandedLeafId: null },
      second: { root: tree(LEAF_C, LEAF_B, LEAF_A), activeLeafId: LEAF_B, expandedLeafId: null },
      third: { root: tree(LEAF_A), activeLeafId: LEAF_A, expandedLeafId: null }
    },
    ...overrides
  }
}

function target(overrides: Partial<Parameters<typeof resolveTerminalPaneTabTarget>[0]> = {}) {
  return resolveTerminalPaneTabTarget({
    state: state(),
    worktreeId: 'workspace',
    tabId: 'first',
    activeLeafId: LEAF_B,
    currentLeafIds: [LEAF_A, LEAF_B],
    direction: 'next',
    ...overrides
  })
}

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('terminal pane navigation across tabs', () => {
  it('moves to the next visual pane before switching tabs', () => {
    expect(target({ activeLeafId: LEAF_A })).toEqual({
      tab: { type: 'terminal', id: 'first' },
      leafId: LEAF_B
    })
  })

  it('enters the next tab at its first pane, not its previously selected pane', () => {
    expect(target()).toEqual({ tab: { type: 'terminal', id: 'second' }, leafId: LEAF_C })
  })

  it('enters the previous tab at its last pane', () => {
    expect(
      target({
        tabId: 'third',
        activeLeafId: LEAF_A,
        currentLeafIds: [LEAF_A],
        direction: 'previous'
      })
    ).toEqual({ tab: { type: 'terminal', id: 'second' }, leafId: LEAF_A })
  })

  it('wraps at the last tab and reverses at the first tab', () => {
    expect(target({ tabId: 'third', activeLeafId: LEAF_A, currentLeafIds: [LEAF_A] })).toEqual({
      tab: { type: 'terminal', id: 'first' },
      leafId: LEAF_A
    })
    expect(target({ activeLeafId: LEAF_A, direction: 'previous' })).toEqual({
      tab: { type: 'terminal', id: 'third' },
      leafId: LEAF_A
    })
  })

  it('honors reordered tabs in the active group and retains the unified tab id', () => {
    const tabs = [tab('first'), tab('second'), tab('third')]
    const reordered = state({
      activeGroupIdByWorktree: { workspace: 'group' },
      groupsByWorktree: {
        workspace: [
          {
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: 'unified-first',
            tabOrder: ['unified-first', 'unified-third', 'unified-second']
          }
        ]
      },
      unifiedTabsByWorktree: { workspace: tabs }
    })
    expect(target({ state: reordered })).toEqual({
      tab: { type: 'terminal', id: 'third', tabId: 'unified-third' },
      leafId: LEAF_A
    })
  })

  it('skips visible structured-chat tabs and terminal tabs in chat view', () => {
    const chat: Tab = {
      ...tab('chat'),
      id: 'unified-chat',
      contentType: 'agent-session',
      agentSessionAgent: 'codex'
    }
    const candidates = state({
      activeGroupIdByWorktree: { workspace: 'group' },
      groupsByWorktree: {
        workspace: [
          {
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: 'unified-first',
            tabOrder: ['unified-first', 'unified-chat', 'unified-second', 'unified-third']
          }
        ]
      },
      unifiedTabsByWorktree: { workspace: [tab('first'), chat, tab('second'), tab('third')] },
      tabsByWorktree: {
        workspace: [
          terminal('first'),
          { ...terminal('second'), viewMode: 'chat' },
          terminal('third')
        ]
      },
      terminalLayoutsByTabId: {
        second: {
          root: tree(LEAF_C),
          activeLeafId: LEAF_C,
          chatLeafId: LEAF_C,
          expandedLeafId: null
        },
        third: { root: tree(LEAF_A), activeLeafId: LEAF_A, expandedLeafId: null }
      }
    })
    expect(target({ state: candidates })).toEqual({
      tab: { type: 'terminal', id: 'third', tabId: 'unified-third' },
      leafId: LEAF_A
    })
  })

  it('includes uncovered terminal panes in mixed chat tabs in both directions', () => {
    const mixed = state({
      tabsByWorktree: {
        workspace: [
          terminal('first'),
          { ...terminal('second'), viewMode: 'chat' },
          terminal('third')
        ]
      },
      terminalLayoutsByTabId: {
        second: {
          root: tree(LEAF_C, LEAF_B, LEAF_A),
          activeLeafId: LEAF_C,
          chatLeafId: LEAF_C,
          expandedLeafId: null
        }
      }
    })
    expect(target({ state: mixed })).toEqual({
      tab: { type: 'terminal', id: 'second' },
      leafId: LEAF_B
    })
    expect(
      target({
        state: mixed,
        tabId: 'third',
        activeLeafId: LEAF_A,
        currentLeafIds: [LEAF_A],
        direction: 'previous'
      })
    ).toEqual({ tab: { type: 'terminal', id: 'second' }, leafId: LEAF_A })
    expect(
      target({
        state: mixed,
        tabId: 'second',
        activeLeafId: LEAF_A,
        currentLeafIds: [LEAF_B, LEAF_A]
      })
    ).toEqual({ tab: { type: 'terminal', id: 'third' }, leafId: null })
  })

  it('never navigates into another split group or worktree', () => {
    const isolated = state({
      activeGroupIdByWorktree: { workspace: 'group' },
      groupsByWorktree: {
        workspace: [
          {
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: 'unified-first',
            tabOrder: ['unified-first']
          }
        ]
      },
      unifiedTabsByWorktree: {
        workspace: [tab('first'), tab('second', 'other')],
        other: [tab('third')]
      }
    })
    expect(target({ state: isolated })).toEqual({
      tab: { type: 'terminal', id: 'first', tabId: 'unified-first' },
      leafId: LEAF_A
    })
  })

  it('falls back to the current tab when it is outside the main tab navigation', () => {
    expect(target({ tabId: 'floating' })).toEqual({
      tab: { type: 'terminal', id: 'floating' },
      leafId: LEAF_A
    })
  })

  it('handles one pane in one tab without changing the target', () => {
    expect(
      target({
        state: state({ tabsByWorktree: { workspace: [terminal('first')] } }),
        activeLeafId: LEAF_A,
        currentLeafIds: [LEAF_A]
      })
    ).toEqual({ tab: { type: 'terminal', id: 'first' }, leafId: LEAF_A })
  })

  it('can activate an unmounted terminal tab without guessing a leaf identity', () => {
    expect(target({ state: state({ terminalLayoutsByTabId: {} }) })).toEqual({
      tab: { type: 'terminal', id: 'second' },
      leafId: null
    })
  })

  it('does not guess when the active pane no longer exists', () => {
    expect(target({ activeLeafId: 'removed' })).toBeNull()
    expect(target({ currentLeafIds: [] })).toBeNull()
  })
})

function pane(id: number, leafId: string) {
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected synthetic leaf UUID')
  }
  const container = document.createElement('div')
  container.dataset.leafId = leafId
  return { id, leafId, container }
}

describe('live pane and tab focus routing', () => {
  it('follows DOM order after a pane reorder instead of creation order', () => {
    const left = pane(1, LEAF_A),
      middle = pane(3, LEAF_C),
      right = pane(2, LEAF_B)
    document.body.append(left.container, middle.container, right.container)
    const manager = {
      getPanes: () => [left, right, middle],
      getActivePane: () => left,
      getNumericIdForLeaf: vi.fn(
        (leafId: string) => [left, middle, right].find((p) => p.leafId === leafId)?.id ?? null
      ),
      setActivePane: vi.fn()
    }
    getState.mockReturnValue(state())
    focusTerminalPaneAcrossTabs(manager, 'workspace', 'first', 'next')
    expect(manager.setActivePane).toHaveBeenCalledWith(3, { focus: true })
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('activates the exact target group tab and requests expansion collapse before focus', () => {
    const active = pane(2, LEAF_B)
    document.body.append(active.container)
    const s = state({
      activeGroupIdByWorktree: { workspace: 'group' },
      groupsByWorktree: {
        workspace: [
          {
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: 'unified-first',
            tabOrder: ['unified-first', 'unified-second']
          }
        ]
      },
      unifiedTabsByWorktree: { workspace: [tab('first'), tab('second')] }
    })
    const activateTab = vi.fn()
    getState.mockReturnValue({ ...s, activateTab })
    focusTerminalPaneAcrossTabs(
      {
        getPanes: () => [active],
        getActivePane: () => active,
        getNumericIdForLeaf: vi.fn(),
        setActivePane: vi.fn()
      },
      'workspace',
      'first',
      'next'
    )
    expect(activateTabAndFocusPane).toHaveBeenCalledWith('second', LEAF_C, {
      collapseExpandedPane: true
    })
    expect(activateTab).toHaveBeenCalledWith('unified-second')
  })

  it('uses the mounted-surface focus helper when the destination has no saved leaf yet', () => {
    const active = pane(2, LEAF_B)
    document.body.append(active.container)
    getState.mockReturnValue({ ...state({ terminalLayoutsByTabId: {} }), activateTab: vi.fn() })
    focusTerminalPaneAcrossTabs(
      {
        getPanes: () => [active],
        getActivePane: () => active,
        getNumericIdForLeaf: vi.fn(),
        setActivePane: vi.fn()
      },
      'workspace',
      'first',
      'next'
    )
    expect(activateTabAndFocusPane).toHaveBeenCalledWith('second', null, {
      collapseExpandedPane: true
    })
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('second')
  })
})
