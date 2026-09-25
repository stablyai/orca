import { describe, expect, it } from 'vitest'
import {
  continueMainAgentStatus,
  mainAgentTurnInterrupted,
  foldAgentLeadStatus,
  isAgentTimeAccruing,
  isAgentStatusHeldOpenByChildWork
} from './agent-lead-status-fold'

describe('foldAgentLeadStatus', () => {
  it('keeps a lead that is not settled, whatever its children do', () => {
    expect(foldAgentLeadStatus({ leadState: 'blocked', childWorkLiveness: 'working' })).toEqual({
      stateName: 'blocked'
    })
  })

  it('reads a settled lead with live agent work as working', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: 'working' })).toEqual({
      stateName: 'working'
    })
  })

  it('reads a settled lead with only watch loops as monitoring', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: 'monitoring' })).toEqual({
      stateName: 'working',
      workingMode: 'monitoring'
    })
  })

  it("takes no verdict: how the mainAgent's turn ended is not a fold input", () => {
    // A cancel is a fact about the main agent, carried on `mainAgent.outcome`; the work it left running
    // reads exactly as it would after a plain end of turn.
    const input: Parameters<typeof foldAgentLeadStatus>[0] = {
      leadState: 'done',
      childWorkLiveness: 'monitoring'
    }
    expect(Object.keys(input)).toEqual(['leadState', 'childWorkLiveness'])
    expect(foldAgentLeadStatus(input)).toEqual({ stateName: 'working', workingMode: 'monitoring' })
  })

  it('settles when nothing is running', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: null })).toEqual({
      stateName: 'done'
    })
  })

  describe('a child waiting on a human', () => {
    it('makes a working or settled main agent wait', () => {
      for (const leadState of ['working', 'done'] as const) {
        expect(foldAgentLeadStatus({ leadState, childWorkLiveness: 'waiting' })).toEqual({
          stateName: 'waiting'
        })
      }
    })

    it("yields to the main agent's own request for a human, in the main agent's own vocabulary", () => {
      for (const leadState of ['waiting', 'blocked'] as const) {
        expect(foldAgentLeadStatus({ leadState, childWorkLiveness: 'waiting' })).toEqual({
          stateName: leadState
        })
      }
    })
  })
})

describe('mainAgentTurnInterrupted', () => {
  it('reads only a cancellation verdict as an interrupt', () => {
    expect(mainAgentTurnInterrupted({ outcome: 'cancellation' })).toBe(true)
    expect(mainAgentTurnInterrupted({ outcome: 'failure' })).toBe(false)
    expect(mainAgentTurnInterrupted({})).toBe(false)
    expect(mainAgentTurnInterrupted(undefined)).toBe(false)
  })
})

describe('isAgentStatusHeldOpenByChildWork', () => {
  it('is true only when a settled main agent sits under a row that is not settled', () => {
    expect(
      isAgentStatusHeldOpenByChildWork({ state: 'working', mainAgent: { state: 'done' } })
    ).toBe(true)
    expect(isAgentStatusHeldOpenByChildWork({ state: 'done', mainAgent: { state: 'done' } })).toBe(
      false
    )
    expect(
      isAgentStatusHeldOpenByChildWork({ state: 'working', mainAgent: { state: 'working' } })
    ).toBe(false)
    // No main agent fact means no claim: an old host's row is never read as child-held.
    expect(isAgentStatusHeldOpenByChildWork({ state: 'working' })).toBe(false)
  })
})

describe('isAgentTimeAccruing', () => {
  it('accrues while the row works for the main agent or its live agent child work', () => {
    expect(isAgentTimeAccruing({ state: 'working' })).toBe(true)
  })

  it('pauses while the row waits on the user, whoever raised the prompt', () => {
    expect(isAgentTimeAccruing({ state: 'waiting' })).toBe(false)
    expect(isAgentTimeAccruing({ state: 'blocked' })).toBe(false)
  })

  it('does not accrue for a watch loop or a settled row', () => {
    expect(isAgentTimeAccruing({ state: 'working', workingMode: 'monitoring' })).toBe(false)
    expect(isAgentTimeAccruing({ state: 'done' })).toBe(false)
  })

  it('relies on the fold emitting monitoring only for a settled main agent', () => {
    // Every lane folds through here (Codex never emits monitoring), so a monitoring row can never
    // hide a running main agent turn from the stats.
    const leadStates = ['working', 'waiting', 'blocked', 'done'] as const
    const liveness = ['waiting', 'working', 'monitoring', null] as const
    for (const leadState of leadStates) {
      for (const childWorkLiveness of liveness) {
        const folded = foldAgentLeadStatus({ leadState, childWorkLiveness })
        const accrues = isAgentTimeAccruing({
          state: folded.stateName,
          workingMode: folded.workingMode
        })
        // A child waiting on a human pauses the row, whatever the main agent is doing.
        expect(accrues).toBe(
          childWorkLiveness !== 'waiting' &&
            (leadState === 'working' || (leadState === 'done' && childWorkLiveness === 'working'))
        )
      }
    }
  })
})

describe('continueMainAgentStatus', () => {
  it('keeps the clock across an unchanged state and restarts it on a change', () => {
    const first = continueMainAgentStatus(undefined, { state: 'working' }, 10)
    expect(first).toEqual({ state: 'working', stateStartedAt: 10 })
    expect(continueMainAgentStatus(first, { state: 'working' }, 20)).toEqual({
      state: 'working',
      stateStartedAt: 10
    })
    expect(continueMainAgentStatus(first, { state: 'done', outcome: 'failure' }, 30)).toEqual({
      state: 'done',
      outcome: 'failure',
      stateStartedAt: 30
    })
  })

  it('lets a caller that knows the instant win, and never carries a verdict onto a live state', () => {
    expect(continueMainAgentStatus(undefined, { state: 'done', stateStartedAt: 4 }, 30)).toEqual({
      state: 'done',
      stateStartedAt: 4
    })
    expect(
      continueMainAgentStatus(undefined, { state: 'working', outcome: 'cancellation' }, 30)
    ).toEqual({ state: 'working', stateStartedAt: 30 })
  })
})
