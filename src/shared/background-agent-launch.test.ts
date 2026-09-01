import { describe, expect, it } from 'vitest'
import {
  backgroundAgentLaunchAttemptSchema,
  parseBackgroundAgentLaunchAttempt,
  type BackgroundAgentLaunchAttempt,
  type BackgroundAgentLaunchState
} from './background-agent-launch'
import type { PersistedAgentLaunchFailure } from './agent-launch-contract'

const unknownFailure: PersistedAgentLaunchFailure = {
  code: 'launch_state_unknown',
  requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
  baseAgent: 'codex',
  version: 1,
  failureId: 'fail-9',
  intent: 'background',
  occurredAt: 5
}

function attempt(
  overrides: Partial<BackgroundAgentLaunchAttempt> = {}
): BackgroundAgentLaunchAttempt {
  return {
    attemptId: 'a1b2c3d4-1111-4111-8111-111111111111',
    worktreeId: 'repo-a::/srv/app',
    operationId: 'op-1',
    requestedAgent: 'codex',
    baseAgent: 'codex',
    state: 'pending',
    failure: null,
    createdAt: 1,
    updatedAt: 2,
    forgottenAt: null,
    ...overrides
  }
}

describe('backgroundAgentLaunchAttemptSchema', () => {
  it('round-trips a well-formed attempt in each state', () => {
    const states: BackgroundAgentLaunchState[] = ['pending', 'launched', 'failed', 'forgotten']
    for (const state of states) {
      expect(parseBackgroundAgentLaunchAttempt(attempt({ state }))).toEqual(attempt({ state }))
    }
  })

  it('models launch_state_unknown as pending coexisting with an unknown-coded failure', () => {
    const stranded = attempt({ state: 'pending', failure: unknownFailure })
    const parsed = parseBackgroundAgentLaunchAttempt(stranded)
    expect(parsed?.state).toBe('pending')
    expect(parsed?.failure?.code).toBe('launch_state_unknown')
  })

  it('retains the failure and stamps forgottenAt on the forgotten terminal', () => {
    const forgotten = attempt({ state: 'forgotten', failure: unknownFailure, forgottenAt: 42 })
    const parsed = parseBackgroundAgentLaunchAttempt(forgotten)
    expect(parsed?.state).toBe('forgotten')
    expect(parsed?.forgottenAt).toBe(42)
    expect(parsed?.failure?.code).toBe('launch_state_unknown')
  })

  it('rejects an unknown state', () => {
    expect(
      parseBackgroundAgentLaunchAttempt(
        attempt({ state: 'exploded' as BackgroundAgentLaunchState })
      )
    ).toBeNull()
  })

  it('rejects an unknown/extra field so a corrupt row drops on read', () => {
    expect(parseBackgroundAgentLaunchAttempt({ ...attempt(), launchToken: 'leaked' })).toBeNull()
    expect(parseBackgroundAgentLaunchAttempt({ ...attempt(), snapshot: {} })).toBeNull()
  })

  it('rejects an unknown requested agent and a non-null non-base baseAgent', () => {
    expect(
      parseBackgroundAgentLaunchAttempt(
        attempt({ requestedAgent: 'nope' as BackgroundAgentLaunchAttempt['requestedAgent'] })
      )
    ).toBeNull()
    expect(
      parseBackgroundAgentLaunchAttempt(
        attempt({ baseAgent: 'nope' as BackgroundAgentLaunchAttempt['baseAgent'] })
      )
    ).toBeNull()
  })

  it('allows a null baseAgent before resolution', () => {
    expect(backgroundAgentLaunchAttemptSchema.safeParse(attempt({ baseAgent: null })).success).toBe(
      true
    )
  })

  it('rejects an embedded failure that carries an unknown field', () => {
    const bad = { ...attempt(), failure: { ...unknownFailure, agentEnv: { S: '1' } } }
    expect(parseBackgroundAgentLaunchAttempt(bad)).toBeNull()
  })

  it('rejects an embedded control-plane request error masquerading as the failure', () => {
    const bad = {
      ...attempt(),
      failure: { ...unknownFailure, code: 'idempotency_conflict' }
    }
    expect(parseBackgroundAgentLaunchAttempt(bad)).toBeNull()
  })
})
