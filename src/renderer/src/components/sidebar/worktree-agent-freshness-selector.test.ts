import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import { createWorktreeAgentFreshnessSelector } from './worktree-agent-freshness-selector'

const WT_1_PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const WT_2_PANE = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEntry(paneKey: string, worktreeId: string, updatedAt: number): AgentStatusEntry {
  return {
    paneKey,
    worktreeId,
    state: 'working',
    stateStartedAt: updatedAt,
    updatedAt,
    stateHistory: [],
    prompt: 'working',
    agentType: 'claude'
  }
}

function makeState(agentStatusEpoch: number, wt1UpdatedAt: number, wt2UpdatedAt: number) {
  return {
    agentStatusEpoch,
    tabsByWorktree: {
      'wt-1': [makeTab('tab-1', 'wt-1')],
      'wt-2': [makeTab('tab-2', 'wt-2')]
    },
    agentStatusByPaneKey: {
      [WT_1_PANE]: makeEntry(WT_1_PANE, 'wt-1', wt1UpdatedAt),
      [WT_2_PANE]: makeEntry(WT_2_PANE, 'wt-2', wt2UpdatedAt)
    },
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {}
  }
}

describe('createWorktreeAgentFreshnessSelector', () => {
  it('changes only the worktree whose row crosses the stale boundary', () => {
    let now = AGENT_STATUS_STALE_AFTER_MS - 1
    const state = makeState(1, now - 1, 0)
    const selectWt1 = createWorktreeAgentFreshnessSelector('wt-1', () => now)
    const selectWt2 = createWorktreeAgentFreshnessSelector('wt-2', () => now)
    const firstWt1 = selectWt1(state)
    const firstWt2 = selectWt2(state)

    now = AGENT_STATUS_STALE_AFTER_MS + 1
    const nextState = { ...state, agentStatusEpoch: 2 }

    // The global scheduler bumps one epoch for all cards. Zustand compares the
    // selected string by value, so the unrelated card now skips its render.
    expect(selectWt1(nextState)).toBe(firstWt1)
    expect(selectWt2(nextState)).not.toBe(firstWt2)
  })

  it('does constant work for same-epoch status-map churn', () => {
    const readNow = vi.fn(() => 1_000)
    const selector = createWorktreeAgentFreshnessSelector('wt-1', readNow)
    const state = makeState(3, 900, 900)
    const first = selector(state)

    const sameStatePing = {
      ...state,
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [WT_2_PANE]: { ...state.agentStatusByPaneKey[WT_2_PANE], updatedAt: 950 }
      }
    }

    expect(selector(sameStatePing)).toBe(first)
    expect(readNow).toHaveBeenCalledTimes(1)
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'wakes a %s row when it becomes stale',
    (state) => {
      let now = AGENT_STATUS_STALE_AFTER_MS - 1
      const initial = makeState(10, 0, now)
      initial.agentStatusByPaneKey[WT_1_PANE].state = state
      const selector = createWorktreeAgentFreshnessSelector('wt-1', () => now)
      const fresh = selector(initial)

      now = AGENT_STATUS_STALE_AFTER_MS + 1

      expect(selector({ ...initial, agentStatusEpoch: 11 })).not.toBe(fresh)
    }
  )
})
