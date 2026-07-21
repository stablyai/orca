import { describe, expect, it } from 'vitest'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const NOW = 1_000_000_000
const TAB_ID = 'tab1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const GONE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
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

function tab(): unknown {
  return {
    id: TAB_ID,
    ptyId: 'pty1',
    worktreeId: 'w1',
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function baseState(overrides: Partial<DashboardSnapshotState>): DashboardSnapshotState {
  return {
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000' }],
    worktreesByRepo: { r1: [{ id: 'w1', displayName: 'wt-one', isArchived: false }] },
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

describe('buildDashboardSnapshot', () => {
  it('maps a live working agent to the working bucket with a resolved ptyId', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({ state: 'working', lastAssistantMessage: 'Working on it now' })
        }
      }),
      NOW
    )
    expect(snapshot.cards).toHaveLength(1)
    const card = snapshot.cards[0]
    expect(card.bucket).toBe('working')
    expect(card.dotState).toBe('working')
    expect(card.ptyId).toBe('pty1')
    expect(card.worktreeName).toBe('wt-one')
    expect(card.repoName).toBe('Repo One')
    expect(card.leafId).toBe(LEAF_ID)
    expect(card.lastUserMessage).toBe('do the thing')
    expect(card.lastAgentMessage).toBe('Working on it now')
    // Column ordering key: when the agent entered its current state.
    expect(card.stateChangedAt).toBe(NOW - 5000)
    // No ack yet → unseen, mirroring the sidebar's unvisited signal.
    expect(card.unseen).toBe(true)
  })

  it('nulls ptyId when the layout entry points at a dead pty', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        // Layout still remembers pty1 (it survives restarts), but the live
        // set says that pty is gone — e.g. a parked tab after an app restart.
        ptyIdsByTabId: { [TAB_ID]: [] }
      }),
      NOW
    )
    expect(snapshot.cards[0].ptyId).toBeNull()
  })

  it('mutes unseen once the agent is acknowledged after its state change', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: { [PANE_KEY]: entry({}) },
        acknowledgedAgentsByPaneKey: { [PANE_KEY]: NOW - 1000 }
      }),
      NOW
    )
    // ack (NOW-1000) is after stateStartedAt (NOW-5000) → seen.
    expect(snapshot.cards[0].unseen).toBe(false)
  })

  it('does not mark title-derived rows unseen from synthetic timestamps', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {},
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: '⠋ Claude Code' }
        }
      }),
      NOW
    )

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0].startedAt).toBe(0)
    expect(snapshot.cards[0].unseen).toBe(false)
  })

  it.each(['blocked', 'waiting'] as const)(
    'routes %s agents to the attention bucket with an ask summary',
    (state) => {
      const snapshot = buildDashboardSnapshot(
        baseState({
          agentStatusByPaneKey: {
            [PANE_KEY]: entry({ state, interactivePrompt: 'Approve deploy?' })
          }
        }),
        NOW
      )
      expect(snapshot.cards[0].bucket).toBe('attention')
      expect(snapshot.cards[0].dotState).toBe(state)
      expect(snapshot.cards[0].askSummary).toBe('Approve deploy?')
    }
  )

  it('decays a stale working agent to the idle bucket', () => {
    const snapshot = buildDashboardSnapshot(
      baseState({
        agentStatusByPaneKey: {
          [PANE_KEY]: entry({
            state: 'working',
            updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1000
          })
        }
      }),
      NOW
    )
    expect(snapshot.cards[0].bucket).toBe('idle')
    expect(snapshot.cards[0].dotState).toBe('idle')
  })

  it('folds retained done agents into the idle bucket, keeping a done dot', () => {
    const donePaneKey = makePaneKey(TAB_ID, GONE_LEAF_ID)
    const snapshot = buildDashboardSnapshot(
      baseState({
        retainedAgentsByPaneKey: {
          [donePaneKey]: {
            entry: entry({ paneKey: donePaneKey, state: 'done' }),
            worktreeId: 'w1',
            tab: tab() as never,
            agentType: 'claude',
            startedAt: NOW - 60_000
          } as never
        }
      }),
      NOW
    )
    const done = snapshot.cards.find((c) => c.dotState === 'done')
    expect(done).toBeDefined()
    expect(done?.bucket).toBe('idle')
  })
})
