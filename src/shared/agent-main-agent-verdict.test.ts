import { describe, expect, it } from 'vitest'
import {
  agentMainAgentVerdict,
  agentTurnEndedUncleanly,
  type AgentMainAgentVerdictSource
} from './agent-main-agent-verdict'
import type { AgentStatusState } from './agent-status-types'
import { AGENT_JOURNAL_TURN_OUTCOMES, type AgentJournalTurnOutcome } from './agent-turn-outcome'

const STATES: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
const OUTCOMES: (AgentJournalTurnOutcome | undefined)[] = [
  undefined,
  ...AGENT_JOURNAL_TURN_OUTCOMES
]

function expected(row: AgentMainAgentVerdictSource): AgentJournalTurnOutcome | null {
  if (row.state !== 'done') {
    return null
  }
  return row.mainAgent?.outcome ?? row.outcome ?? (row.interrupted ? 'cancellation' : null)
}

const PRODUCT: AgentMainAgentVerdictSource[] = STATES.flatMap((state) =>
  OUTCOMES.flatMap((mainOutcome) =>
    OUTCOMES.flatMap((topOutcome) =>
      [undefined, false, true].map((interrupted) => ({
        state,
        ...(interrupted !== undefined ? { interrupted } : {}),
        ...(mainOutcome ? { mainAgent: { outcome: mainOutcome } } : {}),
        ...(topOutcome ? { outcome: topOutcome } : {})
      }))
    )
  )
)

describe('agentMainAgentVerdict', () => {
  it('decodes the one verdict over every state, both fidelities and the legacy flag', () => {
    for (const row of PRODUCT) {
      expect(agentMainAgentVerdict(row), JSON.stringify(row)).toBe(expected(row))
      expect(agentTurnEndedUncleanly(row), JSON.stringify(row)).toBe(
        expected(row) === 'cancellation' || expected(row) === 'failure'
      )
    }
  })

  it('reads a row whose lead failed while its child still works as working, not failed', () => {
    const row = { state: 'working' as const, mainAgent: { outcome: 'failure' as const } }
    expect(agentMainAgentVerdict(row)).toBeNull()
    expect(agentTurnEndedUncleanly(row)).toBe(false)
  })

  it('prefers the recorded verdict over the legacy flag', () => {
    expect(
      agentMainAgentVerdict({ state: 'done', interrupted: true, mainAgent: { outcome: 'failure' } })
    ).toBe('failure')
  })
})
