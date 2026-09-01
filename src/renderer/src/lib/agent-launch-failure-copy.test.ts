import { describe, it, expect } from 'vitest'
import {
  agentLaunchFailureMessage,
  agentLaunchRequestErrorMessage,
  agentLaunchOutcomeErrorMessage,
  isAgentLaunchFailureCopy
} from './agent-launch-failure-copy'
import type {
  AgentLaunchFailureCode,
  AgentLaunchRequestError
} from '../../../shared/agent-launch-contract'

// Every AgentLaunchFailureCode the host can return. Kept as a literal list so a
// new code added to the contract without copy fails this test (and the switch's
// exhaustiveness guard fails the build first).
const ALL_FAILURE_CODES: AgentLaunchFailureCode[] = [
  'unknown_agent',
  'no_agent_selected',
  'agent_definition_needs_repair',
  'custom_agent_disabled',
  'agent_configuration_changed',
  'base_agent_disabled',
  'base_agent_unavailable',
  'missing_variable',
  'missing_target_home',
  'invalid_command_override',
  'invalid_agent_args',
  'invalid_agent_env',
  'secure_env_transport_unavailable',
  'launch_command_too_long',
  'invalid_launch_snapshot',
  'trust_preflight_failed',
  'spawn_failed',
  'launch_state_unknown',
  'launch_capacity_exceeded'
]

const ALL_REQUEST_ERROR_CODES: AgentLaunchRequestError['code'][] = [
  'idempotency_conflict',
  'stale_agent_launch_failure',
  'untrusted_reference'
]

describe('agentLaunchFailureMessage', () => {
  it('returns a non-empty message for every failure code', () => {
    for (const code of ALL_FAILURE_CODES) {
      const message = agentLaunchFailureMessage({ code })
      expect(message.length).toBeGreaterThan(0)
      // Client-safe: copy must never echo the raw code back to the user.
      expect(message).not.toBe(code)
    }
  })

  it('maps distinct codes to distinct copy', () => {
    const messages = ALL_FAILURE_CODES.map((code) => agentLaunchFailureMessage({ code }))
    expect(new Set(messages).size).toBe(ALL_FAILURE_CODES.length)
  })

  it('points repairable failures at Settings', () => {
    for (const code of [
      'custom_agent_disabled',
      'base_agent_disabled',
      'invalid_command_override',
      'invalid_agent_args',
      'invalid_agent_env'
    ] as const) {
      expect(agentLaunchFailureMessage({ code })).toContain('Settings')
    }
  })

  it('gives agent_configuration_changed owner-accurate copy per surface', () => {
    const postCreate = agentLaunchFailureMessage(
      { code: 'agent_configuration_changed' },
      'post-create'
    )
    const preSpawn = agentLaunchFailureMessage({ code: 'agent_configuration_changed' }, 'pre-spawn')
    expect(postCreate).not.toBe(preSpawn)
    expect(postCreate).toContain('being created')
    expect(preSpawn).toContain('before launch')
    // Retry is the fix, not a passive "review in Settings".
    expect(postCreate).not.toContain('Settings')
    expect(preSpawn).not.toContain('Settings')
  })

  it('defaults agent_configuration_changed to the pre-spawn surface', () => {
    expect(agentLaunchFailureMessage({ code: 'agent_configuration_changed' })).toBe(
      agentLaunchFailureMessage({ code: 'agent_configuration_changed' }, 'pre-spawn')
    )
  })

  it('frames capacity as pending on the host, not an invalid definition', () => {
    const message = agentLaunchFailureMessage({ code: 'launch_capacity_exceeded' })
    expect(message).toContain('pending on this host')
    expect(message).not.toContain('Settings')
  })
})

describe('agentLaunchRequestErrorMessage', () => {
  it('returns a non-empty message for every request-error code', () => {
    for (const code of ALL_REQUEST_ERROR_CODES) {
      const message = agentLaunchRequestErrorMessage({ code })
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toBe(code)
    }
  })
})

describe('isAgentLaunchFailureCopy', () => {
  it('recognizes every failure copy on both surfaces', () => {
    for (const code of ALL_FAILURE_CODES) {
      expect(isAgentLaunchFailureCopy(agentLaunchFailureMessage({ code }, 'pre-spawn'))).toBe(true)
      expect(isAgentLaunchFailureCopy(agentLaunchFailureMessage({ code }, 'post-create'))).toBe(
        true
      )
    }
  })

  it('recognizes every request-error copy', () => {
    for (const code of ALL_REQUEST_ERROR_CODES) {
      expect(isAgentLaunchFailureCopy(agentLaunchRequestErrorMessage({ code }))).toBe(true)
    }
  })

  it('rejects an arbitrary terminal error line', () => {
    expect(isAgentLaunchFailureCopy('Paste failed.')).toBe(false)
    expect(isAgentLaunchFailureCopy('')).toBe(false)
  })

  it('names the next step for a lost launch snapshot', () => {
    expect(agentLaunchFailureMessage({ code: 'invalid_launch_snapshot' })).toContain(
      'Launch the agent again'
    )
  })
})

describe('agentLaunchOutcomeErrorMessage', () => {
  it('routes a failed outcome to the failure copy', () => {
    expect(
      agentLaunchOutcomeErrorMessage({ status: 'failed', failure: { code: 'spawn_failed' } })
    ).toBe(agentLaunchFailureMessage({ code: 'spawn_failed' }))
  })

  it('routes a rejected outcome to the request-error copy', () => {
    expect(
      agentLaunchOutcomeErrorMessage({
        status: 'rejected',
        requestError: { code: 'untrusted_reference' }
      })
    ).toBe(agentLaunchRequestErrorMessage({ code: 'untrusted_reference' }))
  })
})
