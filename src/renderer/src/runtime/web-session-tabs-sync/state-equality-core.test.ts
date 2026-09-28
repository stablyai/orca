import { describe, expect, it } from 'vitest'
import type { AgentStateHistoryEntry } from '../../../../shared/agent-status-types'
import { sameAgentStateHistory } from './state-equality-core'

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
