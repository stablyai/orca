import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeTab } from './testing/terminal-tab.test-fixture'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const finishedClaudeTurn: AgentStatusEntry = {
  state: 'done',
  prompt: 'fix the bug',
  agentType: 'claude',
  paneKey: PANE_KEY,
  updatedAt: 1_000,
  stateStartedAt: 1_000,
  stateHistory: [],
  turnEndedAt: 1_000
}

function storeWithIdleClaudeTab(cacheTimerByKey: Record<string, number | 'requested'>) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: '✳ Claude Code' })]
    },
    agentStatusByPaneKey: { [PANE_KEY]: finishedClaudeTurn },
    cacheTimerByKey
  })
  return store
}

describe('seedCacheTimersForIdleTabs', () => {
  it('starts the countdown at the turn end of a pane that sent a request while the timer was off', () => {
    const store = storeWithIdleClaudeTab({ [PANE_KEY]: 'requested' })

    store.getState().seedCacheTimersForIdleTabs()

    expect(store.getState().cacheTimerByKey).toEqual({ [PANE_KEY]: 1_000 })
  })

  it('does not start a countdown for a pane with no request this session', () => {
    const store = storeWithIdleClaudeTab({})

    store.getState().seedCacheTimersForIdleTabs()

    expect(store.getState().cacheTimerByKey).toEqual({})
  })
})
