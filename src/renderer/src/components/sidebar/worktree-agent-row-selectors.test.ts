import { describe, expect, it } from 'vitest'
import type {
  AgentStatusEntry,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
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
