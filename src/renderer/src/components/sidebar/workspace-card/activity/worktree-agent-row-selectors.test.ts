import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

import type { Tab } from '../../../../../../shared/tab-types'

import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import { selectLiveAgentStatusEntriesForWorktree } from './worktree-agent-row-selectors'

const PANE_KEY_1 = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')

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

describe('selectLiveAgentStatusEntriesForWorktree', () => {
  it('keeps an idle structured session visible while its unified tab exists', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, {
      state: 'done',
      sessionBoundary: true,
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    })
    const structuredTab = {
      id: 'tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: false,
      agentSessionAgent: 'codex'
    } satisfies Tab
    const state = {
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] },
      agentStatusByPaneKey: { [PANE_KEY_1]: entry },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }

    expect(selectLiveAgentStatusEntriesForWorktree(state, 'wt-1')).toEqual([entry])
    expect(
      selectLiveAgentStatusEntriesForWorktree(
        { ...state, unifiedTabsByWorktree: { 'wt-1': [] } },
        'wt-1'
      )
    ).toEqual([])
  })

  it('falls back to a full rebuild when a within-map update changes worktree attribution', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1'
    })
    const state = {
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
    const entry = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1'
    })
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
})

// Inactive inline-agent hooks need a shared identity to avoid allocating on every store write.
