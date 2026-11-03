import { describe, expect, it } from 'vitest'
import { continueMainAgentStatus } from './agent-lead-status-fold'

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
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      expect(continueMainAgentStatus(undefined, { state, outcome: 'cancellation' }, 30)).toEqual({
        state,
        stateStartedAt: 30
      })
    }
  })
})
