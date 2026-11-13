import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
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
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] },
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY_1]: entry })),
      migrationUnsupportedByPtyId: {}
    })

    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([entry])
    store.setState({ unifiedTabsByWorktree: { 'wt-1': [] } })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([])
  })

  it('moves the live row when its worktree attribution changes', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1'
    })
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [], 'wt-2': [] },
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY_1]: entry })),
      migrationUnsupportedByPtyId: {}
    })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([entry])

    const moved = { ...entry, worktreeId: 'wt-2' }
    store.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY_1]: moved }))
    })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([])
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-2')).toEqual([moved])
  })

  it('removes a completed live row when its tab is gone', () => {
    const entry = makeEntry(PANE_KEY_1, 1000, {
      state: 'working',
      worktreeId: 'wt-1'
    })
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [] },
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY_1]: entry })),
      migrationUnsupportedByPtyId: {}
    })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([entry])

    // done + tab absent must drop the row (bucket rule), not be patched in place.
    const done = { ...entry, state: 'done' as const }
    store.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY_1]: done }))
    })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([])
  })
  it('reads a new live agent after the last row was removed without an intervening read', () => {
    const store = createTestStore()
    const first = makeEntry(PANE_KEY_1, 1000, { state: 'working', worktreeId: 'wt-1' })
    store.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[PANE_KEY_1, first]]) })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([first])
    store.getState().removeAgentStatus(PANE_KEY_1)
    const second = makeEntry('tab-2:33333333-3333-4333-8333-333333333333', 1001, {
      state: 'working',
      worktreeId: 'wt-1',
      prompt: 'new task'
    })
    store.setState({
      agentStatusByPaneKey: store
        .getState()
        .agentStatusByPaneKey.replace([[second.paneKey, second]])
    })
    expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([second])
  })
})
