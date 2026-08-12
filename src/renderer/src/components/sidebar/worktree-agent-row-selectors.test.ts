import { describe, expect, it } from 'vitest'
import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getLiveEntriesFullRebuildCountForTests } from './worktree-agent-live-index-patch'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './worktree-agent-row-selectors'

const PANE_KEY_1 = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
const PANE_KEY_2 = makePaneKey('tab-2', '33333333-3333-4333-8333-333333333333')

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

function makeRetained(paneKey: string, worktreeId: string, startedAt: number): RetainedAgentEntry {
  return {
    entry: makeEntry(paneKey, startedAt),
    worktreeId,
    tab: makeTab(paneKey.slice(0, paneKey.indexOf(':'))),
    agentType: 'claude',
    startedAt
  }
}

describe('selectMigrationUnsupportedEntriesForWorktree', () => {
  it('returns raw migration records so shallow selectors can cache snapshots', () => {
    const unsupported: MigrationUnsupportedPtyEntry = {
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: '44444444-4444-4444-8444-444444444444',
      paneKey: makePaneKey('tab-1', '44444444-4444-4444-8444-444444444444'),
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1000
    }
    const state = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: { 'pty-1': unsupported },
      retainedAgentsByPaneKey: {}
    }

    const first = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')
    const second = selectMigrationUnsupportedEntriesForWorktree(state, 'wt-1')

    // Why: the Electron black-screen regression came from creating converted
    // AgentStatusEntry objects inside the Zustand selector. Returning store
    // records preserves element identity for useShallow.
    expect(first).toEqual([unsupported])
    expect(second).toEqual([unsupported])
    expect(first).toBe(second)
    expect(first[0]).toBe(second[0])
  })
})

describe('selectLiveAgentStatusEntriesForWorktree', () => {
  it('reuses unaffected worktree arrays when another worktree receives a same-state ping', () => {
    const wt1Entry = makeEntry(PANE_KEY_1, 1000, { state: 'working', prompt: 'first' })
    const wt2Entry = makeEntry(PANE_KEY_2, 1000, { state: 'working', prompt: 'first' })
    const state = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1')],
        'wt-2': [makeTab('tab-2')]
      },
      agentStatusByPaneKey: {
        [PANE_KEY_1]: wt1Entry,
        [PANE_KEY_2]: wt2Entry
      },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    const firstWt1 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')
    const firstWt2 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-2')
    const nextState = {
      ...state,
      agentStatusByPaneKey: {
        [PANE_KEY_1]: wt1Entry,
        [PANE_KEY_2]: {
          ...wt2Entry,
          prompt: 'updated prompt preview',
          updatedAt: 1100
        }
      }
    }

    const secondWt1 = selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-1')
    const secondWt2 = selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-2')

    // Why: WorktreeCard mounts one selector per visible card. A same-state
    // hook ping for wt-2 must not make wt-1 pay a fresh array/render cost.
    expect(secondWt1).toBe(firstWt1)
    expect(secondWt2).not.toBe(firstWt2)
    expect(secondWt2[0]?.prompt).toBe('updated prompt preview')
  })

  it('uses worktree attribution when the status tab is not in the renderer tab list', () => {
    const childEntry = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    })
    const state = {
      tabsByWorktree: {
        'wt-1': []
      },
      agentStatusByPaneKey: {
        [PANE_KEY_1]: childEntry
      },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    expect(selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')).toEqual([childEntry])
  })

  it('patches instead of full-rebuilding across within-state pings, and stays correct on transitions', () => {
    const wt1Entry = makeEntry(PANE_KEY_1, 1000, { state: 'working', prompt: 'wt1 prompt' })
    const wt2Entry = makeEntry(PANE_KEY_2, 1000, { state: 'working', prompt: 'wt2 prompt' })
    const baseState = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1')],
        'wt-2': [makeTab('tab-2')]
      },
      agentStatusByPaneKey: {
        [PANE_KEY_1]: wt1Entry,
        [PANE_KEY_2]: wt2Entry
      },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    // Prime the cache (one full rebuild allowed here).
    const primedWt1 = selectLiveAgentStatusEntriesForWorktree(baseState, 'wt-1')
    const primedWt2 = selectLiveAgentStatusEntriesForWorktree(baseState, 'wt-2')
    const rebuildsAfterPrime = getLiveEntriesFullRebuildCountForTests()

    // Simulate a burst of same-state pings: setAgentStatus mints a new map and
    // a new entry object per ping, with only prompt/tool metadata changing.
    let state = baseState
    let latestWt2 = primedWt2
    for (let ping = 0; ping < 50; ping += 1) {
      state = {
        ...state,
        agentStatusByPaneKey: {
          ...state.agentStatusByPaneKey,
          [PANE_KEY_2]: {
            ...wt2Entry,
            prompt: `wt2 prompt ${ping}`,
            toolName: 'Bash',
            toolInput: `cmd ${ping}`,
            updatedAt: 1000 + ping
          }
        }
      }
      const wt1 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')
      latestWt2 = selectLiveAgentStatusEntriesForWorktree(state, 'wt-2')
      // Unaffected worktree keeps identity; owning worktree serves the fresh entry.
      expect(wt1).toBe(primedWt1)
      expect(latestWt2).toHaveLength(1)
      expect(latestWt2[0]?.prompt).toBe(`wt2 prompt ${ping}`)
      expect(latestWt2[0]?.toolInput).toBe(`cmd ${ping}`)
    }
    // The O(all live agents) rebuild body never ran for within-state pings.
    expect(getLiveEntriesFullRebuildCountForTests()).toBe(rebuildsAfterPrime)
    expect(latestWt2).not.toBe(primedWt2)

    // A real transition that changes bucketing (working -> done with the tab
    // still present keeps the bucket; removing the entry must drop it).
    const doneState = {
      ...state,
      agentStatusByPaneKey: {
        [PANE_KEY_1]: state.agentStatusByPaneKey[PANE_KEY_1]
      }
    }
    expect(selectLiveAgentStatusEntriesForWorktree(doneState, 'wt-2')).toEqual([])
    expect(selectLiveAgentStatusEntriesForWorktree(doneState, 'wt-1')).toEqual([wt1Entry])
    expect(getLiveEntriesFullRebuildCountForTests()).toBe(rebuildsAfterPrime + 1)
  })

  it('falls back to a full rebuild when a within-map update changes worktree attribution', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, { state: 'working', worktreeId: 'wt-1' })
    const state = {
      // No tab membership: bucketing comes from entry.worktreeId attribution.
      tabsByWorktree: { 'wt-1': [], 'wt-2': [] },
      agentStatusByPaneKey: { [PANE_KEY_1]: entry },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }
    expect(selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')).toEqual([entry])

    const moved = { ...entry, worktreeId: 'wt-2' }
    const nextState = {
      ...state,
      agentStatusByPaneKey: { [PANE_KEY_1]: moved }
    }
    expect(selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-1')).toEqual([])
    expect(selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-2')).toEqual([moved])
  })

  it('falls back to a full rebuild when a live entry completes with its tab gone', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, { state: 'working', worktreeId: 'wt-1' })
    const state = {
      tabsByWorktree: { 'wt-1': [] },
      agentStatusByPaneKey: { [PANE_KEY_1]: entry },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }
    expect(selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')).toEqual([entry])

    // done + tab absent must drop the row (bucket rule), not be patched in place.
    const done = { ...entry, state: 'done' as const }
    const nextState = {
      ...state,
      agentStatusByPaneKey: { [PANE_KEY_1]: done }
    }
    expect(selectLiveAgentStatusEntriesForWorktree(nextState, 'wt-1')).toEqual([])
  })

  it('does not use worktree attribution for a completed row whose tab is gone', () => {
    const closedEntry = makeEntry(PANE_KEY_1, 1000, {
      state: 'done',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      agentType: 'pi'
    })
    const state = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-live')]
      },
      agentStatusByPaneKey: {
        [PANE_KEY_1]: closedEntry
      },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    expect(selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')).toEqual([])
  })
})

describe('selectRuntimeAgentOrchestrationForWorktree', () => {
  it('includes child orchestration metadata when only the parent tab is in the worktree', () => {
    const childPaneKey = makePaneKey('tab-child', '44444444-4444-4444-8444-444444444444')
    const state = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1')]
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          parentPaneKey: PANE_KEY_1
        }
      }
    }

    expect(selectRuntimeAgentOrchestrationForWorktree(state, 'wt-1')).toEqual({
      [childPaneKey]: state.runtimeAgentOrchestrationByPaneKey[childPaneKey]
    })
  })

  it('includes child orchestration metadata for a worktree-attributed live row without tab membership', () => {
    const childPaneKey = makePaneKey('tab-child', '44444444-4444-4444-8444-444444444444')
    const childEntry = makeEntry(childPaneKey, 1000, {
      worktreeId: 'wt-1'
    })
    const state = {
      tabsByWorktree: {
        'wt-1': []
      },
      agentStatusByPaneKey: {
        [childPaneKey]: childEntry
      },
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          parentPaneKey: PANE_KEY_1
        }
      }
    }

    expect(selectRuntimeAgentOrchestrationForWorktree(state, 'wt-1')).toEqual({
      [childPaneKey]: state.runtimeAgentOrchestrationByPaneKey[childPaneKey]
    })
  })

  it('includes child orchestration metadata for a retained worktree row without tab membership', () => {
    const childPaneKey = makePaneKey('tab-child', '44444444-4444-4444-8444-444444444444')
    const retainedChild = makeRetained(childPaneKey, 'wt-1', 1000)
    const state = {
      tabsByWorktree: {
        'wt-1': []
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        [childPaneKey]: retainedChild
      },
      runtimeAgentOrchestrationByPaneKey: {
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          parentPaneKey: PANE_KEY_1
        }
      }
    }

    expect(selectRuntimeAgentOrchestrationForWorktree(state, 'wt-1')).toEqual({
      [childPaneKey]: state.runtimeAgentOrchestrationByPaneKey[childPaneKey]
    })
  })
})

describe('selectRetainedAgentEntriesForWorktree', () => {
  it('reuses unaffected worktree arrays when another worktree retained row changes', () => {
    const wt1Retained = makeRetained(PANE_KEY_1, 'wt-1', 1000)
    const wt2Retained = makeRetained(PANE_KEY_2, 'wt-2', 1000)
    const state = {
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {
        [PANE_KEY_1]: wt1Retained,
        [PANE_KEY_2]: wt2Retained
      }
    }

    const firstWt1 = selectRetainedAgentEntriesForWorktree(state, 'wt-1')
    const firstWt2 = selectRetainedAgentEntriesForWorktree(state, 'wt-2')
    const nextState = {
      ...state,
      retainedAgentsByPaneKey: {
        [PANE_KEY_1]: wt1Retained,
        [PANE_KEY_2]: {
          ...wt2Retained,
          startedAt: 1100
        }
      }
    }

    const secondWt1 = selectRetainedAgentEntriesForWorktree(nextState, 'wt-1')
    const secondWt2 = selectRetainedAgentEntriesForWorktree(nextState, 'wt-2')

    expect(secondWt1).toBe(firstWt1)
    expect(secondWt2).not.toBe(firstWt2)
    expect(secondWt2[0]?.startedAt).toBe(1100)
  })
})
