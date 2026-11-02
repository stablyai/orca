import { describe, expect, it } from 'vitest'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotInput as DashboardSnapshotState
} from './build-dashboard-snapshot'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const NOW = 1_000_000_000
const TAB_ID = 'tab1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: NOW,
    stateStartedAt: NOW - 5000,
    stateHistory: [],
    agentType: 'claude',
    tabId: TAB_ID,
    worktreeId: 'w1',
    ...overrides
  }
}

function tab(id = TAB_ID, worktreeId = 'w1'): TerminalTab {
  return {
    id,
    ptyId: 'pty1',
    worktreeId,
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function worktree(id = 'w1', displayName = 'wt-one'): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r1/${id}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW
  }
}

function baseState(overrides: Partial<DashboardSnapshotState>): DashboardSnapshotState {
  return {
    chatNames: new Map(),
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r1: [worktree()] },
    tabsByWorktree: { w1: [tab()] },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty1'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    ...overrides
  }
}

describe('buildDashboardSnapshot unread completions', () => {
  it('asks for review when a completed turn has not been opened, and releases it once acknowledged', () => {
    const finished = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            state: 'done',
            lastAssistantMessage: 'Should I tag v2.1 now?'
          })
        }
      }),
      NOW
    ).cards[0]
    // Plain-text question, normal Stop: the turn ended unseen, so it waits in Needs You.
    expect(finished.unseen).toBe(true)
    expect(finished.bucket).toBe('attention')
    expect(finished.dotState).toBe('done')
    expect(finished.lastAgentMessage).toBe('Should I tag v2.1 now?')

    const acked = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ state: 'done' })
        },
        acknowledgedAgentsByPaneKey: { [PANE_KEY]: NOW - 1000 }
      }),
      NOW
    ).cards[0]
    // Opening the agent acks the turn; the card leaves Needs You for good.
    expect(acked.bucket).not.toBe('attention')
    expect(acked.bucket).toBe('idle')
  })
})
