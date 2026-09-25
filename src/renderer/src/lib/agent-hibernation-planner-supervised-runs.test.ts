/**
 * The cheap half of the obligation guard: never sleep a pane whose dispatched
 * worker has not reported back. Belt-and-braces — correctness rests on the
 * wake-on-message path, so a gap here is no longer a silent deadlock.
 */
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
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function tab(id = 'tab-1', worktreeId = 'wt-bg'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(leafId = LEAF, ptyId = 'pty-1'): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? `tab-1:${LEAF}`
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

function snapshotWith(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): AgentHibernationPlannerSnapshot {
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    mobileLockedPtyIds: [],
    agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW
  }
}

function workerOf(
  coordinator: AgentStatusEntry,
  dispatchStatus: 'dispatched' | 'completed'
): AgentStatusEntry {
  return {
    ...entry({ paneKey: `tab-2:${OTHER_LEAF}`, tabId: 'tab-2' }),
    orchestration: {
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      dispatchStatus,
      parentPaneKey: coordinator.paneKey
    }
  }
}

function plannedPaneKeys(input: AgentHibernationPlannerSnapshot): string[] {
  return planAgentHibernationCandidates(input).map((candidate) => candidate.paneKey)
}

describe('agent sleep planner and supervised runs', () => {
  it('refuses to sleep a coordinator whose dispatched worker has not reported back', () => {
    const coordinator = entry()
    const worker = workerOf(coordinator, 'dispatched')
    const input = snapshotWith({
      [coordinator.paneKey]: coordinator,
      [worker.paneKey]: worker
    })
    expect(plannedPaneKeys(input)).toEqual([])
  })

  it('sleeps the same coordinator once its worker settles', () => {
    const coordinator = entry()
    const worker = workerOf(coordinator, 'completed')
    const input = snapshotWith({
      [coordinator.paneKey]: coordinator,
      [worker.paneKey]: worker
    })
    expect(plannedPaneKeys(input)).toEqual([coordinator.paneKey])
  })
})
