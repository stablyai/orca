import { describe, expect, it } from 'vitest'
import {
  agentMainAgentVerdict,
  agentTurnEndedUncleanly,
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark,
  agentVerdictFields
} from './agent-main-agent-verdict'
import type { AgentTurnOutcome } from './agent-turn-outcome'

describe('agentMainAgentVerdict', () => {
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
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      expect(
        agentMainAgentVerdict({ state: 'done', interrupted: true, mainAgent: { state } })
      ).toBeNull()
    }
  })

  it('reads the legacy flag only on a done row, and under a done main agent with no outcome', () => {
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      expect(agentMainAgentVerdict({ state, interrupted: true })).toBeNull()
      expect(
        agentMainAgentVerdict({ state, interrupted: true, mainAgent: { state: 'done' } })
      ).toBeNull()
    }
    expect(agentMainAgentVerdict({ state: 'done' })).toBeNull()
    expect(agentMainAgentVerdict({ state: 'done', interrupted: false })).toBeNull()
    expect(agentMainAgentVerdict({ state: 'done', mainAgent: { state: 'done' } })).toBeNull()
    expect(
      agentMainAgentVerdict({ state: 'done', interrupted: true, mainAgent: { state: 'done' } })
    ).toBe('cancellation')
    expect(agentMainAgentVerdict({ state: 'done', interrupted: true })).toBe('cancellation')
  })

  it("marks a done row by its verdict: a user's Stop reads interrupted, any other cut failed", () => {
    for (const [outcome, mark, unclean, onPurpose] of [
      ['success', null, false, false],
      ['failure', 'failed', true, false],
      ['cancellation', 'interrupted', true, true],
      // A newer request replaced it: not news, and no one to name.
      ['superseded', 'interrupted', true, true],
      ['interruption', 'failed', true, false],
      ['unconfirmed', 'unconfirmed', true, false]
    ] as const) {
      const row = { state: 'done' as const, mainAgent: { state: 'done' as const, outcome } }
      expect(agentVerdictDisplayMark(row), outcome).toBe(mark)
      expect(agentTurnEndedUncleanly(row), outcome).toBe(unclean)
      expect(agentTurnEndedOnPurpose(row), outcome).toBe(onPurpose)
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
