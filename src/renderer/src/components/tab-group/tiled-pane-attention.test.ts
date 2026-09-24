import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  isTiledAgentsModeActive,
  parseTiledPaneAttentionKey,
  resolveTiledMaximizedGroupId,
  selectTiledAgentsReconcileKey,
  selectTiledPaneAttentionKey,
  tiledPaneFrameClassName
} from './tiled-pane-attention'

const WORKTREE_ID = 'wt-1'
const NOW = Date.now()

function makeGroup(id: string, activeTabId: string | null): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId, tabOrder: activeTabId ? [activeTabId] : [] }
}

function makeAgentTab(id: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeTerminalTab(id: string, groupId: string): Tab {
  return { ...makeAgentTab(id, groupId), contentType: 'terminal' }
}

/** A terminal-route agent tab: unified tab id differs from the sibling TerminalTab id
 *  (its entityId), exactly as real terminal-route tabs are shaped (SPEC-V2 2.1). */
function makeAgentRouteTab(unifiedTabId: string, terminalTabId: string, groupId: string): Tab {
  return {
    id: unifiedTabId,
    entityId: terminalTabId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: unifiedTabId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

/** The sibling TerminalTab that marks a terminal-route tab as an agent pane (SPEC-V2 2.1). */
function makeLaunchAgentTerminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent: 'claude'
  }
}

function makeEntry(
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: 'tab:leaf-1',
    stateHistory: [],
    ...overrides
  }
}

function baseState(overrides: {
  groups: TabGroup[]
  tabs: Tab[]
  terminalTabs?: TerminalTab[]
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  tiled?: boolean
  experimentOn?: boolean
  cardGroupIds?: string[]
}) {
  return {
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalTiledAgents: overrides.experimentOn ?? true
    },
    groupsByWorktree: { [WORKTREE_ID]: overrides.groups },
    unifiedTabsByWorktree: { [WORKTREE_ID]: overrides.tabs },
    tabsByWorktree: { [WORKTREE_ID]: overrides.terminalTabs ?? [] },
    agentStatusByPaneKey: overrides.agentStatusByPaneKey ?? {},
    agentStatusEpoch: 0,
    agentCardGroupIdsByWorktree: { [WORKTREE_ID]: overrides.cardGroupIds ?? [] }
  }
}

function makeAgentsTab(id: string, groupId: string): Tab {
  return { ...makeAgentTab(id, groupId), contentType: 'agents' }
}

describe('isTiledAgentsModeActive', () => {
  it('follows the global experiment only', () => {
    expect(
      isTiledAgentsModeActive(
        baseState({ groups: [], tabs: [], experimentOn: true, tiled: true }),
        WORKTREE_ID
      )
    ).toBe(true)
    expect(
      isTiledAgentsModeActive(
        baseState({ groups: [], tabs: [], experimentOn: false, tiled: true }),
        WORKTREE_ID
      )
    ).toBe(false)
    expect(
      isTiledAgentsModeActive(
        baseState({ groups: [], tabs: [], experimentOn: true, tiled: false }),
        WORKTREE_ID
      )
    ).toBe(true)
  })
})

describe('resolveTiledMaximizedGroupId', () => {
  function maximizedState(overrides: { experimentOn: boolean; tiled: boolean }) {
    return {
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalTiledAgents: overrides.experimentOn
      },
      maximizedGroupIdByWorktree: { [WORKTREE_ID]: 'g1' }
    }
  }

  it('returns the maximized group id when the experiment is on', () => {
    expect(
      resolveTiledMaximizedGroupId(maximizedState({ experimentOn: true, tiled: true }), WORKTREE_ID)
    ).toBe('g1')
  })

  it('returns undefined when the global experiment is off, even mid-maximize', () => {
    expect(
      resolveTiledMaximizedGroupId(
        maximizedState({ experimentOn: false, tiled: true }),
        WORKTREE_ID
      )
    ).toBeUndefined()
  })

  it('still returns the maximized group id when the experiment is on', () => {
    expect(
      resolveTiledMaximizedGroupId(
        maximizedState({ experimentOn: true, tiled: false }),
        WORKTREE_ID
      )
    ).toBe('g1')
  })
})

describe('selectTiledPaneAttentionKey', () => {
  it('returns empty string when the experiment is off', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('blocked') },
      tiled: false,
      experimentOn: false
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('')
  })

  it('includes a blocked agent pane', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('blocked') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:blocked')
  })

  it('includes a waiting agent pane', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('waiting') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:waiting')
  })

  it('includes a done agent pane', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('done') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:done')
  })

  it('excludes a working agent pane (working stays plain)', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('working') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('')
  })

  it('excludes a stale entry past the staleness window', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1')],
      agentStatusByPaneKey: {
        't1:leaf-1': makeEntry('blocked', { updatedAt: NOW - 40 * 60 * 1000 })
      }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('')
  })

  it('excludes a non-agent-session tab', () => {
    const state = baseState({
      groups: [makeGroup('g1', 't1')],
      tabs: [makeTerminalTab('t1', 'g1')],
      agentStatusByPaneKey: { 't1:leaf-1': makeEntry('blocked') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('')
  })

  it('excludes a plain terminal tab even with a same-id status entry (no sibling launchAgent)', () => {
    const state = baseState({
      groups: [makeGroup('g1', 'unified-1')],
      tabs: [makeAgentRouteTab('unified-1', 'term-1', 'g1')],
      terminalTabs: [],
      agentStatusByPaneKey: { 'term-1:leaf-1': makeEntry('blocked') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('')
  })

  it('includes a blocked terminal-route agent pane, keyed by the sibling TerminalTab id', () => {
    const state = baseState({
      groups: [makeGroup('g1', 'unified-1')],
      tabs: [makeAgentRouteTab('unified-1', 'term-1', 'g1')],
      terminalTabs: [makeLaunchAgentTerminalTab('term-1')],
      agentStatusByPaneKey: { 'term-1:leaf-1': makeEntry('blocked') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:blocked')
  })

  it('includes a waiting terminal-route agent pane', () => {
    const state = baseState({
      groups: [makeGroup('g1', 'unified-1')],
      tabs: [makeAgentRouteTab('unified-1', 'term-1', 'g1')],
      terminalTabs: [makeLaunchAgentTerminalTab('term-1')],
      agentStatusByPaneKey: { 'term-1:leaf-1': makeEntry('waiting') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:waiting')
  })

  it('includes a done terminal-route agent pane', () => {
    const state = baseState({
      groups: [makeGroup('g1', 'unified-1')],
      tabs: [makeAgentRouteTab('unified-1', 'term-1', 'g1')],
      terminalTabs: [makeLaunchAgentTerminalTab('term-1')],
      agentStatusByPaneKey: { 'term-1:leaf-1': makeEntry('done') }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:done')
  })

  it('sorts multiple qualifying groups', () => {
    const state = baseState({
      groups: [makeGroup('g2', 't2'), makeGroup('g1', 't1')],
      tabs: [makeAgentTab('t1', 'g1'), makeAgentTab('t2', 'g2')],
      agentStatusByPaneKey: {
        't1:leaf-1': makeEntry('waiting'),
        't2:leaf-1': makeEntry('done')
      }
    })
    expect(selectTiledPaneAttentionKey(state, WORKTREE_ID)).toBe('g1:waiting,g2:done')
  })
})

describe('parseTiledPaneAttentionKey', () => {
  it('parses an empty key to an empty map', () => {
    expect(parseTiledPaneAttentionKey('').size).toBe(0)
  })

  it('round-trips a multi-entry key', () => {
    const map = parseTiledPaneAttentionKey('g1:blocked,g2:done')
    expect(map.get('g1')).toBe('blocked')
    expect(map.get('g2')).toBe('done')
  })
})

describe('selectTiledAgentsReconcileKey', () => {
  it('returns empty when the experiment is off, regardless of the tri-state choice', () => {
    const state = baseState({
      groups: [],
      tabs: [makeAgentTab('t1', 'g1')],
      tiled: true,
      experimentOn: false
    })
    expect(selectTiledAgentsReconcileKey(state, WORKTREE_ID)).toBe('')
  })

  it('joins the experiment flag and the ordered agent tab ids', () => {
    const state = baseState({
      groups: [],
      tabs: [makeAgentTab('t2', 'g2'), makeAgentTab('t1', 'g1')],
      tiled: true
    })
    expect(selectTiledAgentsReconcileKey(state, WORKTREE_ID)).toBe('1|||t1,t2')
  })

  it('still reports an on-and-empty key so the reconciler can run its deactivate branch', () => {
    const state = baseState({ groups: [], tabs: [], tiled: false })
    expect(selectTiledAgentsReconcileKey(state, WORKTREE_ID)).toBe('1|||')
  })

  it('includes a terminal-route agent id resolved from the sibling TerminalTab slice', () => {
    const state = baseState({
      groups: [],
      tabs: [makeAgentRouteTab('unified-1', 'term-1', 'g1')],
      terminalTabs: [makeLaunchAgentTerminalTab('term-1')],
      tiled: true
    })
    expect(selectTiledAgentsReconcileKey(state, WORKTREE_ID)).toBe('1|||unified-1')
  })

  it('changes when the Agents tab disappears even though the ordered agent tab ids are unchanged (B3)', () => {
    // Why: B1/Close Group can drop the Agents tab without changing the agent tab set;
    // the reconciler must still see a different key so it can self-heal.
    const agentTab = makeAgentTab('t1', 'g-card-1')
    const withAgentsTab = baseState({
      groups: [],
      tabs: [makeAgentsTab('agents-1', 'g-home'), agentTab],
      tiled: true,
      cardGroupIds: ['g-card-1']
    })
    const withoutAgentsTab = baseState({
      groups: [],
      tabs: [agentTab],
      tiled: true,
      cardGroupIds: ['g-card-1']
    })
    expect(selectTiledAgentsReconcileKey(withAgentsTab, WORKTREE_ID)).not.toBe(
      selectTiledAgentsReconcileKey(withoutAgentsTab, WORKTREE_ID)
    )
  })

  it('changes when the card group registry changes even though the ordered agent tab ids are unchanged (B3)', () => {
    const agentTab = makeAgentTab('t1', 'g-card-1')
    const withCardGroup = baseState({
      groups: [],
      tabs: [agentTab],
      tiled: true,
      cardGroupIds: ['g-card-1']
    })
    const withoutCardGroup = baseState({
      groups: [],
      tabs: [agentTab],
      tiled: true,
      cardGroupIds: []
    })
    expect(selectTiledAgentsReconcileKey(withCardGroup, WORKTREE_ID)).not.toBe(
      selectTiledAgentsReconcileKey(withoutCardGroup, WORKTREE_ID)
    )
  })
})

describe('tiledPaneFrameClassName', () => {
  it('returns nothing when the pane is not tiled', () => {
    expect(tiledPaneFrameClassName(undefined)).toBe('')
  })

  it('returns the plain card geometry with no color', () => {
    expect(tiledPaneFrameClassName('plain')).toBe(
      'rounded-lg border border-border/60 hover:border-border'
    )
  })

  it("tints blocked with the dot's red, through the destructive token not a raw color (I6)", () => {
    expect(tiledPaneFrameClassName('blocked')).toContain('border-destructive/40')
  })

  it('tints waiting with the agent-question token', () => {
    expect(tiledPaneFrameClassName('waiting')).toContain('border-agent-question/40')
  })

  it('tints done with emerald, through the workspace-status-review token not a raw color (I6)', () => {
    expect(tiledPaneFrameClassName('done')).toContain('border-workspace-status-review/40')
  })
})
