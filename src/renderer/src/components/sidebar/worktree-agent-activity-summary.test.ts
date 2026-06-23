import { afterEach, describe, expect, it, vi } from 'vitest'
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
