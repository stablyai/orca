import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'

const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function layout(leaves: Record<string, string>): TerminalLayoutSnapshot {
  const [firstLeaf] = Object.keys(leaves)
  return {
    root: { type: 'leaf', leafId: firstLeaf },
    activeLeafId: firstLeaf,
    expandedLeafId: null,
    ptyIdsByLeafId: leaves
  }
}

function doneEntry(tabId: string, leafId: string): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey: `${tabId}:${leafId}`,
    tabId,
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: `session-${tabId}-${leafId}` },
    stateHistory: []
  }
}

// Three idle done agents: tab-a (one pane), tab-b (one pane), tab-c (two panes).
function snapshot(tabs: TerminalTab[]): AgentHibernationPlannerSnapshot {
  const entries = [
    doneEntry('tab-a', LEAF_A),
    doneEntry('tab-b', LEAF_B),
    doneEntry('tab-c', LEAF_C),
    doneEntry('tab-c', LEAF_A)
  ]
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': tabs },
    terminalLayoutsByTabId: {
      'tab-a': layout({ [LEAF_A]: 'pty-a' }),
      'tab-b': layout({ [LEAF_B]: 'pty-b' }),
      'tab-c': layout({ [LEAF_C]: 'pty-c1', [LEAF_A]: 'pty-c2' })
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'], 'tab-c': ['pty-c1', 'pty-c2'] },
    mobileLockedPtyIds: [],
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry])),
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW
  }
}

function plannedPaneKeys(tabs: TerminalTab[]): string[] {
  return planAgentHibernationCandidates(snapshot(tabs)).map((candidate) => candidate.paneKey)
}

describe('per-tab Never Hibernate', () => {
  it('still hibernates every idle done agent when no tab opted out', () => {
    expect(plannedPaneKeys([tab('tab-a'), tab('tab-b'), tab('tab-c')])).toEqual([
      `tab-a:${LEAF_A}`,
      `tab-b:${LEAF_B}`,
      `tab-c:${LEAF_A}`,
      `tab-c:${LEAF_C}`
    ])
  })

  it('never plans an opted-out tab, however long it has been idle', () => {
    const planned = plannedPaneKeys([tab('tab-a', { neverHibernate: true }), tab('tab-b')])
    expect(planned).toEqual([`tab-b:${LEAF_B}`])
  })

  it('exempts every agent pane of an opted-out split tab and only that tab', () => {
    const planned = plannedPaneKeys([tab('tab-a'), tab('tab-c', { neverHibernate: true })])
    expect(planned).toEqual([`tab-a:${LEAF_A}`])
  })

  it('treats an explicit false like an absent flag', () => {
    expect(plannedPaneKeys([tab('tab-a', { neverHibernate: false })])).toEqual([`tab-a:${LEAF_A}`])
  })

  it('does not let one opted-out tab keep its siblings in the same worktree awake', () => {
    const planned = plannedPaneKeys([
      tab('tab-a', { neverHibernate: true }),
      tab('tab-b'),
      tab('tab-c')
    ])
    expect(planned).toEqual([`tab-b:${LEAF_B}`, `tab-c:${LEAF_A}`, `tab-c:${LEAF_C}`])
  })
})
