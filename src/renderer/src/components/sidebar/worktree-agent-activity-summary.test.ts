import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import {
  selectWorktreeAgentActivitySummary,
  type AgentActivityInput
} from './worktree-agent-activity-summary'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  worktreeId?: string
  parentPaneKey?: string
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    orchestration: args.parentPaneKey
      ? {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey: args.parentPaneKey
        }
      : undefined
  }
}

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('selectWorktreeAgentActivitySummary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds one cached agent summary index for multiple worktree lookups', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const retainedTab = makeTab('tab-2', 'repo::/wt-2')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')],
        'repo::/wt-2': [retainedTab]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {
        'tab-2:0': {
          entry: makeAgentStatusEntry({ paneKey: 'tab-2:0', state: 'done' }),
          worktreeId: 'repo::/wt-2',
          tab: retainedTab,
          agentType: 'claude',
          startedAt: 1_000
        }
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true,
      hasRetainedDone: false
    })
    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-2')).toMatchObject({
      hasLiveWorking: false,
      hasRetainedDone: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached summary when same-state agent pings only clone the status map', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const tabsByWorktree = {
      'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')]
    }
    const migrationUnsupportedByPtyId = {}
    const retainedAgentsByPaneKey = {}
    const entry = makeAgentStatusEntry({ paneKey, state: 'working' })
    const state: AgentActivityInput = {
      tabsByWorktree,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [paneKey]: entry
      },
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey
    }
    const sameStatePing = {
      ...state,
      agentStatusByPaneKey: {
        [paneKey]: {
          ...entry,
          prompt: 'new prompt preview',
          updatedAt: 1_500
        }
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true
    })
    expect(selectWorktreeAgentActivitySummary(sameStatePing, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the summary when the agent status epoch changes', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const tabsByWorktree = {
      'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')]
    }
    const migrationUnsupportedByPtyId = {}
    const retainedAgentsByPaneKey = {}
    const state: AgentActivityInput = {
      tabsByWorktree,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'working' })
      },
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey
    }
    const changedState = {
      ...state,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done' })
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true,
      hasLiveDone: false
    })
    expect(selectWorktreeAgentActivitySummary(changedState, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: false,
      hasLiveDone: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(2)
  })

  it('limits summary-reference churn to the transitioning worktree at scale', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeIds = Array.from({ length: 12 }, (_, index) => `repo::/wt-${index}`)
    const tabsByWorktree = Object.fromEntries(
      worktreeIds.map((worktreeId, index) => [worktreeId, [makeTab(`tab-${index}`, worktreeId)]])
    )
    const initialStatuses = Object.fromEntries(
      worktreeIds.map((_, index) => {
        const paneKey = makePaneKey(`tab-${index}`, LEAF_ID)
        return [paneKey, makeAgentStatusEntry({ paneKey, state: 'working' })]
      })
    )
    const changedPaneKey = makePaneKey('tab-11', LEAF_ID)
    const baseInputs = {
      tabsByWorktree,
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
    const state: AgentActivityInput = {
      ...baseInputs,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: initialStatuses
    }
    const changedState: AgentActivityInput = {
      ...baseInputs,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        ...initialStatuses,
        [changedPaneKey]: makeAgentStatusEntry({ paneKey: changedPaneKey, state: 'done' })
      }
    }

    const before = worktreeIds.map((worktreeId) =>
      selectWorktreeAgentActivitySummary(state, worktreeId)
    )
    const after = worktreeIds.map((worktreeId) =>
      selectWorktreeAgentActivitySummary(changedState, worktreeId)
    )
    const changedReferenceCount = after.filter((summary, index) => summary !== before[index]).length
    const shallowNotificationCount = after.filter(
      (summary, index) => !shallow(summary, before[index])
    ).length

    // Why: shallow store subscriptions wake on the nested pane-id map reference.
    // One transition must not schedule downstream work for every other card.
    expect(changedReferenceCount).toBe(1)
    expect(shallowNotificationCount).toBe(1)
    expect(after[11]).toMatchObject({ hasLiveWorking: false, hasLiveDone: true })
  })

  it('reuses only summaries whose pane membership is still current', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeId = 'repo::/wt-1'
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-2', LEAF_ID)
    const replacementPaneKey = makePaneKey('tab-3', LEAF_ID)
    const sharedInputs = {
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
    const initial: AgentActivityInput = {
      ...sharedInputs,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId), makeTab('tab-2', worktreeId)]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' }),
        [secondPaneKey]: makeAgentStatusEntry({ paneKey: secondPaneKey, state: 'working' })
      }
    }
    const reordered: AgentActivityInput = {
      ...initial,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [secondPaneKey]: initial.agentStatusByPaneKey[secondPaneKey],
        [firstPaneKey]: initial.agentStatusByPaneKey[firstPaneKey]
      }
    }
    const replacement: AgentActivityInput = {
      ...sharedInputs,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-3', worktreeId)] },
      agentStatusEpoch: 2,
      agentStatusByPaneKey: {
        [replacementPaneKey]: makeAgentStatusEntry({
          paneKey: replacementPaneKey,
          state: 'working'
        })
      }
    }
    const removed: AgentActivityInput = {
      ...replacement,
      agentStatusEpoch: 3,
      agentStatusByPaneKey: {}
    }

    const first = selectWorktreeAgentActivitySummary(initial, worktreeId)
    const afterReorder = selectWorktreeAgentActivitySummary(reordered, worktreeId)
    const afterReplacement = selectWorktreeAgentActivitySummary(replacement, worktreeId)
    const afterRemoval = selectWorktreeAgentActivitySummary(removed, worktreeId)

    expect(afterReorder).toBe(first)
    expect(afterReplacement).not.toBe(first)
    expect(afterReplacement.agentStatusPaneIdsByTabId).toEqual({
      'tab-3': new Set([LEAF_ID])
    })
    expect(afterRemoval).not.toBe(afterReplacement)
    expect(afterRemoval).toMatchObject({ hasLiveWorking: false })
    expect(afterRemoval.agentStatusPaneIdsByTabId).toEqual({})
  })

  it('summarizes worktree-attributed rows missing from the tab list', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1'
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveDone: true
    })
  })

  it('uses completed worker orchestration to suppress a stale parent pane title', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1',
          parentPaneKey
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }

    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')
    expect(summary.agentStatusPaneIdsByTabId['tab-parent']).toEqual(new Set([LEAF_ID]))
  })

  it('uses runtime orchestration metadata for completed worker parent-pane suppression', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1'
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey
        }
      },
      retainedAgentsByPaneKey: {}
    }

    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')
    expect(summary.agentStatusPaneIdsByTabId['tab-parent']).toEqual(new Set([LEAF_ID]))
  })
})
