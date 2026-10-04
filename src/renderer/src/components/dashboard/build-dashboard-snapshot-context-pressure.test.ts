import { describe, expect, it } from 'vitest'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
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
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000' }],
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
        ptyIdsByLeafId: { [LEAF_ID]: 'pty1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty1'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    ...overrides
  } as unknown as DashboardSnapshotState
}

describe('buildDashboardSnapshot context pressure', () => {
  it('carries exact context pressure at every known level with the flag on', () => {
    const state = (usedTokens: number, flagOn = true): DashboardSnapshotState =>
      baseState({
        settings: { experimentalContextPressure: flagOn } as DashboardSnapshotState['settings'],
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            model: 'claude-sonnet-4-5',
            contextUsage: { usedTokens, maxTokens: 200_000 }
          })
        }
      })

    const critical = buildDashboardSnapshot(state(190_123), NOW).cards[0]
    // Percent is pre-clamped to an integer so the pop-out's memo comparator
    // doesn't churn on sub-percent drift.
    expect(critical.contextPressure).toEqual({
      level: 'critical',
      usedPercent: 95,
      usedTokens: 190_123,
      limitTokens: 200_000,
      limitSource: 'provider',
      usedTokensSource: undefined
    })

    const warning = buildDashboardSnapshot(state(160_000), NOW).cards[0]
    expect(warning.contextPressure).toMatchObject({
      level: 'warning',
      usedPercent: 80,
      usedTokens: 160_000,
      limitTokens: 200_000,
      limitSource: 'provider'
    })

    expect(buildDashboardSnapshot(state(100_000), NOW).cards[0].contextPressure).toMatchObject({
      level: 'ok',
      usedPercent: 50
    })
    expect(
      buildDashboardSnapshot(state(190_123, false), NOW).cards[0].contextPressure
    ).toBeUndefined()
  })

  it('omits context pressure for sessions without provider-reported usage', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        settings: { experimentalContextPressure: true } as DashboardSnapshotState['settings'],
        agentStatusByPaneKey: { [PANE_KEY]: entry({ model: 'claude-sonnet-4-5' }) }
      }),
      NOW
    )
    expect(snapshot.cards[0].contextPressure).toBeUndefined()
  })
})
