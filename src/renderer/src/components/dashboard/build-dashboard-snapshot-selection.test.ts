import { describe, expect, it } from 'vitest'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const NOW = 1_000_000_000
const TAB_ID = 'tab1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SPLIT_SIBLING_LEAF_ID = '55555555-5555-4555-8555-555555555555'
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

function baseState(overrides: Partial<DashboardSnapshotState>): DashboardSnapshotState {
  return {
    repos: [
      { id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: 'neutral', addedAt: NOW }
    ],
    worktreesByRepo: {
      r1: [
        {
          id: 'w1',
          repoId: 'r1',
          path: '/r1/w1',
          head: 'abc123',
          branch: 'main',
          isBare: false,
          isMainWorktree: false,
          displayName: 'wt-one',
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
      ]
    },
    tabsByWorktree: {
      w1: [
        {
          id: TAB_ID,
          ptyId: 'pty1',
          worktreeId: 'w1',
          title: 'agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW
        }
      ]
    },
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

describe('dashboard snapshot selection', () => {
  it('selects only the active workspace, tab, pane, and execution host', () => {
    const state = baseState({
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeWorktreeId: 'w1',
      activeTabId: TAB_ID,
      activeWorkspaceExecutionHostId: 'local',
      agentStatusByPaneKey: { [PANE_KEY]: entry({}) }
    })
    expect(buildDashboardSnapshot(state, NOW).selectedPaneKey).toBe(PANE_KEY)
    expect(buildDashboardSnapshot(state, NOW).selectedExecutionHostId).toBe('local')

    for (const changed of [
      { activeWorktreeId: 'w2' },
      { activeTabId: 'other-tab' },
      { activeWorkspaceExecutionHostId: 'ssh:devbox' as const },
      { activeTabType: 'editor' as const },
      { activeView: 'settings' as const },
      {
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            ...state.terminalLayoutsByTabId[TAB_ID],
            activeLeafId: SPLIT_SIBLING_LEAF_ID
          }
        }
      },
      { agentStatusByPaneKey: {}, runtimePaneTitlesByTabId: {} }
    ]) {
      expect(buildDashboardSnapshot({ ...state, ...changed }, NOW).selectedPaneKey).toBeUndefined()
    }
  })

  it('clears selection while a pending workspace creation covers the terminal', () => {
    const state = baseState({
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeWorktreeId: 'w1',
      activeTabId: TAB_ID,
      agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
      activePendingCreationId: 'pending',
      pendingWorktreeCreations: {
        pending: {
          creationId: 'pending',
          phase: 'fetching',
          status: 'creating',
          startedAt: NOW,
          indeterminate: false,
          loaderVisible: true,
          request: {
            repoId: 'r1',
            name: 'new-workspace',
            setupDecision: 'inherit',
            agent: null,
            pendingFirstAgentMessageRename: false,
            note: '',
            startupPlan: null,
            quickPrompt: '',
            quickTelemetry: null
          }
        }
      }
    })
    expect(buildDashboardSnapshot(state, NOW).selectedPaneKey).toBeUndefined()
    expect(
      buildDashboardSnapshot({ ...state, pendingWorktreeCreations: {} }, NOW).selectedPaneKey
    ).toBe(PANE_KEY)
  })
})
