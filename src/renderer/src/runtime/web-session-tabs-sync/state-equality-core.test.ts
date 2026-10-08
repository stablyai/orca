import { describe, expect, it } from 'vitest'
import type {
  AgentStateHistoryEntry,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { agentStatusEntryEqual, sameAgentStateHistory } from './state-equality-core'

function doneEntry(mainAgent?: AgentStateHistoryEntry['mainAgent']): AgentStateHistoryEntry {
  return { state: 'done', prompt: 'ship it', startedAt: 1_000, ...(mainAgent ? { mainAgent } : {}) }
}

describe('sameAgentStateHistory', () => {
  it('sees a history verdict or main agent clock change under an unchanged flag', () => {
    const failed = doneEntry({ state: 'done', outcome: 'failure', stateStartedAt: 900 })
    expect(sameAgentStateHistory([failed], [{ ...failed }])).toBe(true)
    expect(sameAgentStateHistory([doneEntry()], [failed])).toBe(false)
    expect(
      sameAgentStateHistory(
        [failed],
        [doneEntry({ state: 'done', outcome: 'success', stateStartedAt: 900 })]
      )
    ).toBe(false)
    expect(
      sameAgentStateHistory(
        [failed],
        [doneEntry({ state: 'done', outcome: 'failure', stateStartedAt: 950 })]
      )
    ).toBe(false)
  })
})

describe('agentStatusEntryEqual', () => {
  // A paired client must take a host row whose only change is a new turn under the same state.
  it('sees a new host turn start under an unchanged state', () => {
    const entry: AgentStatusEntry = {
      state: 'working',
      prompt: 'ship it',
      updatedAt: 2_000,
      stateStartedAt: 1_000,
      turnStartedAt: 1_000,
      paneKey: 'tab-1:leaf-1',
      stateHistory: []
    }
    expect(agentStatusEntryEqual(entry, { ...entry })).toBe(true)
    expect(agentStatusEntryEqual(entry, { ...entry, turnStartedAt: 1_500 })).toBe(false)
  })
})
