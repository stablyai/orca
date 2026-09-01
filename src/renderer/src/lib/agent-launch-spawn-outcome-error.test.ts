import { describe, expect, it, vi } from 'vitest'
import {
  AgentLaunchSpawnOutcomeError,
  spawnOutcomeLaunchFailure
} from './agent-launch-spawn-outcome-error'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('AgentLaunchSpawnOutcomeError', () => {
  it('carries the outcome and renders the localized message', () => {
    const error = new AgentLaunchSpawnOutcomeError({
      status: 'failed',
      failure: { code: 'spawn_failed' }
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.outcome).toEqual({ status: 'failed', failure: { code: 'spawn_failed' } })
    expect(error.message).toBe("The agent couldn't be started. Try again.")
  })
})

describe('spawnOutcomeLaunchFailure', () => {
  it('returns the structured failure for a failed spawn outcome', () => {
    const failure = { code: 'custom_agent_disabled' } as const
    const error = new AgentLaunchSpawnOutcomeError({ status: 'failed', failure })
    expect(spawnOutcomeLaunchFailure(error)).toEqual(failure)
  })

  it('returns null for a control-plane rejection (never persists as a failure)', () => {
    const error = new AgentLaunchSpawnOutcomeError({
      status: 'rejected',
      requestError: { code: 'idempotency_conflict' }
    })
    expect(spawnOutcomeLaunchFailure(error)).toBeNull()
  })

  it('returns null for an untyped error or non-error value', () => {
    expect(spawnOutcomeLaunchFailure(new Error('boom'))).toBeNull()
    expect(spawnOutcomeLaunchFailure('boom')).toBeNull()
    expect(spawnOutcomeLaunchFailure(null)).toBeNull()
  })
})
