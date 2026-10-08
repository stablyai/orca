import { describe, expect, it } from 'vitest'
import {
  agentMainAgentVerdict,
  agentTurnEndedUncleanly,
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark,
  agentVerdictFields,
  type AgentMainAgentVerdictSource
} from './agent-main-agent-verdict'
import type { AgentStatusState } from './agent-status-types'
import { AGENT_TURN_OUTCOMES, type AgentTurnOutcome } from './agent-turn-outcome'

const STATES: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
const OUTCOMES: (AgentTurnOutcome | undefined)[] = [undefined, ...AGENT_TURN_OUTCOMES]

// The rule as the plan states it: the main agent's own state decides when a row carries it; a row
// without it (a legacy or old-host row) reads the legacy flag, which alone needs the combined `done`.
function expected(row: AgentMainAgentVerdictSource): AgentTurnOutcome | null {
  const legacyFlag = row.state === 'done' && row.interrupted === true ? 'cancellation' : null
  if (row.mainAgent) {
    return row.mainAgent.state === 'done' ? (row.mainAgent.outcome ?? legacyFlag) : null
  }
  return legacyFlag
}

const MAIN_AGENTS: (AgentMainAgentVerdictSource['mainAgent'] | undefined)[] = [
  undefined,
  ...STATES.flatMap((state) =>
    OUTCOMES.map((outcome) => ({ state, ...(outcome ? { outcome } : {}) }))
  )
]

const PRODUCT: AgentMainAgentVerdictSource[] = STATES.flatMap((state) =>
  MAIN_AGENTS.flatMap((mainAgent) =>
    [undefined, false, true].map((interrupted) => ({
      state,
      ...(interrupted !== undefined ? { interrupted } : {}),
      ...(mainAgent ? { mainAgent } : {})
    }))
  )
)

describe('agentMainAgentVerdict', () => {
  it('decodes the one verdict over (main agent present/absent) x combined state x outcomes x flag', () => {
    for (const row of PRODUCT) {
      const verdict = expected(row)
      const label = JSON.stringify(row)
      expect(agentMainAgentVerdict(row), label).toBe(verdict)
      expect(agentTurnEndedUncleanly(row), label).toBe(verdict !== null && verdict !== 'success')
      expect(agentTurnEndedOnPurpose(row), label).toBe(
        verdict === 'cancellation' || verdict === 'superseded'
      )
      expect(agentVerdictDisplayMark(row), label).toBe(
        verdict === 'failure' || verdict === 'interruption'
          ? 'failed'
          : row.state !== 'done'
            ? null
            : verdict === 'cancellation' || verdict === 'superseded'
              ? 'interrupted'
              : verdict === 'unconfirmed'
                ? 'unconfirmed'
                : null
      )
    }
  })

  it.each(['failure', 'interruption'] as const)(
    'reads a main agent whose turn ended in %s while its subagent still works as failed',
    (outcome) => {
      const row = { state: 'working' as const, mainAgent: { state: 'done' as const, outcome } }
      expect(agentMainAgentVerdict(row)).toBe(outcome)
      expect(agentVerdictDisplayMark(row)).toBe('failed')
    }
  )

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

  it('reads the legacy flag only on a done row, and under a done main agent with no outcome', () => {
    expect(agentMainAgentVerdict({ state: 'working', interrupted: true })).toBeNull()
    expect(
      agentMainAgentVerdict({ state: 'done', interrupted: true, mainAgent: { state: 'done' } })
    ).toBe('cancellation')
    expect(agentMainAgentVerdict({ state: 'done', interrupted: true })).toBe('cancellation')
  })

  it("marks a done row by its verdict: a user's Stop reads interrupted, any other cut failed", () => {
    for (const [outcome, mark] of [
      ['success', null],
      ['failure', 'failed'],
      ['cancellation', 'interrupted'],
      // A newer request replaced it: not news, and no one to name.
      ['superseded', 'interrupted'],
      ['interruption', 'failed'],
      ['unconfirmed', 'unconfirmed']
    ] as const) {
      const row = { state: 'done' as const, mainAgent: { state: 'done' as const, outcome } }
      expect(agentVerdictDisplayMark(row), outcome).toBe(mark)
    }
    // An old host's legacy flag is a user's Stop too.
    expect(agentVerdictDisplayMark({ state: 'done', interrupted: true })).toBe('interrupted')
  })

  it('reads a crash-cut turn as failed and an unproven end as unconfirmed, neither a stop', () => {
    for (const [outcome, mark] of [
      ['interruption', 'failed'],
      ['unconfirmed', 'unconfirmed']
    ] as const) {
      const row = { state: 'done' as const, mainAgent: { state: 'done' as const, outcome } }
      expect(agentVerdictDisplayMark(row)).toBe(mark)
      expect(agentTurnEndedUncleanly(row)).toBe(true)
      // Nobody asked for it, so attention ranks it as news, like a completion or a failure.
      expect(agentTurnEndedOnPurpose(row)).toBe(false)
    }
  })

  it('reads an arm from a newer host as no verdict, so the row reads done as it did', () => {
    const row = {
      state: 'done' as const,
      mainAgent: {
        state: 'done' as const,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a mirrored row reaches the reader unparsed, carrying an arm this build cannot name.
        outcome: 'from-a-newer-host' as AgentTurnOutcome
      }
    }
    expect(agentMainAgentVerdict(row)).toBeNull()
    expect(agentVerdictDisplayMark(row)).toBeNull()
    expect(agentTurnEndedUncleanly(row)).toBe(false)
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

describe('agentVerdictFields', () => {
  const mainAgent = { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 7 }

  it('copies the whole main agent status and a true legacy flag together', () => {
    expect(agentVerdictFields({ interrupted: true, mainAgent })).toEqual({
      interrupted: true,
      mainAgent
    })
  })

  it('copies nothing a row does not carry, and never a false flag', () => {
    expect(agentVerdictFields({ interrupted: false })).toEqual({})
    expect(agentVerdictFields({})).toEqual({})
  })
})
