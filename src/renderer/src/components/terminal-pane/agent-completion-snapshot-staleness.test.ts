import { describe, expect, it } from 'vitest'
import { isSupersededAgentCompletionSnapshot } from './agent-completion-snapshot-staleness'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

const DESKTOP_WORKING_STARTED_AT = 1_700_000_030_000
const REMOTE_TURN_COMPLETED_AT = 1_700_000_005_000

function workingRow(stateStartedAt: number): { state: 'working'; stateStartedAt: number } {
  return { state: 'working', stateStartedAt }
}

function backgroundTurnSnapshot(
  overrides: Partial<AgentCompletionStatusSnapshot> = {}
): AgentCompletionStatusSnapshot {
  return {
    state: 'done',
    prompt: 'review the PR',
    agentType: 'claude',
    stateStartedAt: REMOTE_TURN_COMPLETED_AT,
    turnCompletedAt: REMOTE_TURN_COMPLETED_AT,
    ...overrides
  }
}

function unstampedSnapshot(
  overrides: Partial<AgentCompletionStatusSnapshot> = {}
): AgentCompletionStatusSnapshot {
  return { state: 'done', prompt: 'review the PR', agentType: 'claude', ...overrides }
}

describe('isSupersededAgentCompletionSnapshot', () => {
  it('keeps a remote-clock-trailing background-turn snapshot from looking superseded', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        backgroundTurnSnapshot()
      )
    ).toBe(false)
  })

  it('drops a background turn whose own working boundary predates the stored row', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        backgroundTurnSnapshot({ localStateStartedAt: DESKTOP_WORKING_STARTED_AT - 1 })
      )
    ).toBe(true)
  })

  it('accepts a background turn stamped on the stored row boundary', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        backgroundTurnSnapshot({ localStateStartedAt: DESKTOP_WORKING_STARTED_AT })
      )
    ).toBe(false)
  })

  it('drops an unstamped completion whose boundary predates the stored row', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        unstampedSnapshot({ stateStartedAt: DESKTOP_WORKING_STARTED_AT - 1 })
      )
    ).toBe(true)
  })

  it('drops an unstamped completion that disagrees with the stored row at the same boundary', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        unstampedSnapshot({ stateStartedAt: DESKTOP_WORKING_STARTED_AT })
      )
    ).toBe(true)
  })

  it('accepts an unclocked completion that agrees with the stored row', () => {
    expect(
      isSupersededAgentCompletionSnapshot(
        workingRow(DESKTOP_WORKING_STARTED_AT),
        unstampedSnapshot({ state: 'working' })
      )
    ).toBe(false)
  })

  it('has nothing to supersede without a stored row or a snapshot', () => {
    expect(isSupersededAgentCompletionSnapshot(undefined, backgroundTurnSnapshot())).toBe(false)
    expect(
      isSupersededAgentCompletionSnapshot(workingRow(DESKTOP_WORKING_STARTED_AT), undefined)
    ).toBe(false)
  })
})
