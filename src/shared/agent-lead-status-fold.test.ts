import { describe, expect, it } from 'vitest'
import {
  continueMainAgentStatus,
  mainAgentTurnInterrupted,
  foldAgentLeadStatus,
  isAgentStatusHeldOpenByChildWork
} from './agent-lead-status-fold'

describe('foldAgentLeadStatus', () => {
  it('keeps a lead that is not settled, whatever its children do', () => {
    expect(
      foldAgentLeadStatus({
        leadState: 'blocked',
        interrupted: false,
        childWorkLiveness: 'working'
      })
    ).toEqual({ stateName: 'blocked' })
  })

  it('reads a settled lead with live agent work as working', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: false, childWorkLiveness: 'working' })
    ).toEqual({ stateName: 'working' })
  })

  it('reads a settled lead with only watch loops as monitoring', () => {
    expect(
      foldAgentLeadStatus({
        leadState: 'done',
        interrupted: false,
        childWorkLiveness: 'monitoring'
      })
    ).toEqual({ stateName: 'working', workingMode: 'monitoring' })
  })

  it('does not read a watch loop as monitoring after an interrupt, but keeps agent work', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: true, childWorkLiveness: 'monitoring' })
    ).toEqual({ stateName: 'done' })
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: true, childWorkLiveness: 'working' })
    ).toEqual({ stateName: 'working' })
  })

  it('settles when nothing is running', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: false, childWorkLiveness: null })
    ).toEqual({ stateName: 'done' })
  })

  describe('a child waiting on a human', () => {
    it('makes a working or settled main agent wait, even after an interrupt', () => {
      for (const leadState of ['working', 'done'] as const) {
        for (const interrupted of [false, true]) {
          expect(
            foldAgentLeadStatus({ leadState, interrupted, childWorkLiveness: 'waiting' })
          ).toEqual({ stateName: 'waiting' })
        }
      }
    })

    it("yields to the main agent's own request for a human, in the main agent's own vocabulary", () => {
      for (const leadState of ['waiting', 'blocked'] as const) {
        expect(
          foldAgentLeadStatus({ leadState, interrupted: false, childWorkLiveness: 'waiting' })
        ).toEqual({ stateName: leadState })
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
