import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_FAILURE_CODES,
  agentLaunchFailureSchema,
  parsePersistedAgentLaunchFailure,
  persistedAgentLaunchFailureSchema
} from './agent-launch-failure-schema'
import type { PersistedAgentLaunchFailure } from './agent-launch-contract'

function persisted(
  overrides: Partial<PersistedAgentLaunchFailure> = {}
): PersistedAgentLaunchFailure {
  return {
    code: 'spawn_failed',
    requestedAgent: 'claude',
    baseAgent: 'claude',
    version: 1,
    failureId: 'fail-1',
    intent: 'background',
    occurredAt: 100,
    ...overrides
  }
}

describe('persistedAgentLaunchFailureSchema', () => {
  it('accepts a well-formed persisted failure and round-trips it', () => {
    expect(parsePersistedAgentLaunchFailure(persisted())).toEqual(persisted())
  })

  it('accepts every failure code in the enum (kept in sync with the union)', () => {
    for (const code of AGENT_LAUNCH_FAILURE_CODES) {
      expect(parsePersistedAgentLaunchFailure(persisted({ code }))).not.toBeNull()
    }
  })

  it('rejects a control-plane request error masquerading as a failure', () => {
    // idempotency_conflict / stale_agent_launch_failure / untrusted_reference are
    // AgentLaunchRequestError codes, not failure codes — they must never parse.
    expect(parsePersistedAgentLaunchFailure({ code: 'idempotency_conflict' })).toBeNull()
    expect(parsePersistedAgentLaunchFailure({ code: 'stale_agent_launch_failure' })).toBeNull()
    expect(parsePersistedAgentLaunchFailure({ code: 'untrusted_reference' })).toBeNull()
  })

  it('rejects an unknown/extra field rather than silently persisting it', () => {
    expect(parsePersistedAgentLaunchFailure({ ...persisted(), agentArgs: '--danger' })).toBeNull()
    expect(
      parsePersistedAgentLaunchFailure({ ...persisted(), agentEnv: { SECRET: 'x' } })
    ).toBeNull()
  })

  it('requires version 1, a non-empty failureId, and a known intent', () => {
    expect(parsePersistedAgentLaunchFailure(persisted({ version: 2 as unknown as 1 }))).toBeNull()
    expect(parsePersistedAgentLaunchFailure(persisted({ failureId: '' }))).toBeNull()
    expect(
      parsePersistedAgentLaunchFailure(
        persisted({ intent: 'mystery' as PersistedAgentLaunchFailure['intent'] })
      )
    ).toBeNull()
  })

  it('rejects an unknown requested/base agent identity', () => {
    expect(
      parsePersistedAgentLaunchFailure(
        persisted({
          requestedAgent: 'not-an-agent' as PersistedAgentLaunchFailure['requestedAgent']
        })
      )
    ).toBeNull()
  })

  it('the unversioned failure body schema also rejects extra keys', () => {
    expect(agentLaunchFailureSchema.safeParse({ code: 'spawn_failed' }).success).toBe(true)
    expect(agentLaunchFailureSchema.safeParse({ code: 'spawn_failed', argv: ['x'] }).success).toBe(
      false
    )
  })

  it('the versioned schema is stricter than the body schema (needs the ledger fields)', () => {
    expect(persistedAgentLaunchFailureSchema.safeParse({ code: 'spawn_failed' }).success).toBe(
      false
    )
  })
})
