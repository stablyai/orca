import { describe, expect, it } from 'vitest'
import { resolveAgentStatusStateStartedAt } from './agent-status-state-start'

describe('resolveAgentStatusStateStartedAt', () => {
  it('stamps the observation when there is no row yet', () => {
    expect(
      resolveAgentStatusStateStartedAt({
        previous: undefined,
        nextState: 'working',
        observedAt: 100
      })
    ).toBe(100)
  })

  it('restarts the clock when the state changes', () => {
    expect(
      resolveAgentStatusStateStartedAt({
        previous: { state: 'working', stateStartedAt: 100 },
        nextState: 'done',
        observedAt: 200
      })
    ).toBe(200)
  })

  it.each(['working', 'blocked', 'done'] as const)(
    'holds the clock while the state stays %s',
    (state) => {
      expect(
        resolveAgentStatusStateStartedAt({
          previous: { state, stateStartedAt: 100 },
          nextState: state,
          observedAt: 200
        })
      ).toBe(100)
    }
  )

  // `done` is the case the two structured writers disagreed on before PR 2a. It is not an
  // exception: `agentEntryCompletionAt` reads a settled row's `stateStartedAt` as the completion
  // time, so restamping it on a republish would re-date a turn that already finished.
  it('does not re-date a completed turn when a settled row is republished', () => {
    expect(
      resolveAgentStatusStateStartedAt({
        previous: { state: 'done', stateStartedAt: 100 },
        nextState: 'done',
        observedAt: 200
      })
    ).toBe(100)
  })

  it('restarts a same-state clock for a new turn', () => {
    expect(
      resolveAgentStatusStateStartedAt({
        previous: { state: 'working', stateStartedAt: 100 },
        nextState: 'working',
        observedAt: 200,
        newTurn: true
      })
    ).toBe(200)
  })
})
