import { describe, expect, it } from 'vitest'
import {
  agentMainAgentVerdict,
  agentTurnEndedUncleanly,
  agentTurnStoppedByUser,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from './agent-main-agent-verdict'
import type { AgentStatusState } from './agent-status-types'
import { AGENT_JOURNAL_TURN_OUTCOMES, type AgentJournalTurnOutcome } from './agent-turn-outcome'

const STATES: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
const OUTCOMES: (AgentJournalTurnOutcome | undefined)[] = [
  undefined,
  ...AGENT_JOURNAL_TURN_OUTCOMES
]

// The rule as the plan states it: the main agent's own state decides when a row carries it; a row
// without it (legacy, history, `worktree ps`) reads its top-level copy, and only the legacy flag
// needs the combined `done`.
function expected(row: AgentMainAgentVerdictSource): AgentJournalTurnOutcome | null {
  const legacyFlag = row.state === 'done' && row.interrupted === true ? 'cancellation' : null
  if (row.mainAgent) {
    return row.mainAgent.state === 'done'
      ? (row.mainAgent.outcome ?? row.outcome ?? legacyFlag)
      : null
  }
  return row.outcome ?? legacyFlag
}

const MAIN_AGENTS: (AgentMainAgentVerdictSource['mainAgent'] | undefined)[] = [
  undefined,
  ...STATES.flatMap((state) =>
    OUTCOMES.map((outcome) => ({ state, ...(outcome ? { outcome } : {}) }))
  )
]

const PRODUCT: AgentMainAgentVerdictSource[] = STATES.flatMap((state) =>
  MAIN_AGENTS.flatMap((mainAgent) =>
    OUTCOMES.flatMap((topOutcome) =>
      [undefined, false, true].map((interrupted) => ({
        state,
        ...(interrupted !== undefined ? { interrupted } : {}),
        ...(mainAgent ? { mainAgent } : {}),
        ...(topOutcome ? { outcome: topOutcome } : {})
      }))
    )
  )
)

describe('agentMainAgentVerdict', () => {
  it('decodes the one verdict over (main agent present/absent) x combined state x outcomes x flag', () => {
    for (const row of PRODUCT) {
      const verdict = expected(row)
      const label = JSON.stringify(row)
      expect(agentMainAgentVerdict(row), label).toBe(verdict)
      expect(agentTurnEndedUncleanly(row), label).toBe(
        verdict === 'cancellation' || verdict === 'failure'
      )
      expect(agentTurnStoppedByUser(row), label).toBe(verdict === 'cancellation')
      expect(agentVerdictDisplayMark(row), label).toBe(
        verdict === 'failure'
          ? 'failed'
          : verdict === 'cancellation' && row.state === 'done'
            ? 'interrupted'
            : null
      )
    }
  })

  it('reads a main agent that failed while its subagent still works as failed', () => {
    const row = {
      state: 'working' as const,
      mainAgent: { state: 'done' as const, outcome: 'failure' as const }
    }
    expect(agentMainAgentVerdict(row)).toBe('failure')
    expect(agentVerdictDisplayMark(row)).toBe('failed')
  })

  it('keeps a success or a stop with live subagent work reading working', () => {
    for (const outcome of ['success', 'cancellation'] as const) {
      const row = { state: 'working' as const, mainAgent: { state: 'done' as const, outcome } }
      expect(agentVerdictDisplayMark(row)).toBeNull()
    }
  })

  it('has no verdict while the main agent itself is not done, whatever the combined row says', () => {
    const row = {
      state: 'done' as const,
      interrupted: true,
      mainAgent: { state: 'working' as const }
    }
    expect(agentMainAgentVerdict(row)).toBeNull()
  })

  it('reads a top-level copy even on a working row, and the legacy flag only on a done one', () => {
    expect(agentMainAgentVerdict({ state: 'working', outcome: 'failure' })).toBe('failure')
    expect(agentMainAgentVerdict({ state: 'working', interrupted: true })).toBeNull()
    expect(agentMainAgentVerdict({ state: 'done', interrupted: true })).toBe('cancellation')
  })

  it('prefers the recorded verdict over the legacy flag', () => {
    expect(
      agentMainAgentVerdict({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'failure' }
      })
    ).toBe('failure')
  })
})
