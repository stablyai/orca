import { describe, expect, it } from 'vitest'
import type { AgentLaunchFailureCode } from '../../../shared/agent-launch-contract'
import {
  resolveAgentLaunchRecoveryCard,
  type AgentLaunchRecoveryActionId
} from './agent-launch-recovery-card'

// Literal list kept in sync with AgentLaunchFailureCode so a new code forces an
// explicit recovery-card decision here rather than silently taking the fallback.
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

const EXPECTED_IDLE: Record<
  AgentLaunchFailureCode,
  { primary: AgentLaunchRecoveryActionId; secondary: AgentLaunchRecoveryActionId[] }
> = {
  unknown_agent: { primary: 'choose-agent', secondary: ['manage-agents'] },
  no_agent_selected: { primary: 'choose-agent', secondary: ['manage-agents'] },
  custom_agent_disabled: { primary: 'choose-agent', secondary: ['manage-agents'] },
  base_agent_disabled: { primary: 'choose-agent', secondary: ['manage-agents'] },
  agent_definition_needs_repair: { primary: 'repair-on-host', secondary: ['choose-agent'] },
  invalid_command_override: {
    primary: 'edit-agent-settings',
    secondary: ['retry', 'choose-agent']
  },
  invalid_agent_args: { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] },
  invalid_agent_env: { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] },
  missing_variable: { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] },
  missing_target_home: { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] },
  launch_command_too_long: { primary: 'edit-agent-settings', secondary: ['retry', 'choose-agent'] },
  base_agent_unavailable: { primary: 'retry', secondary: ['choose-agent'] },
  trust_preflight_failed: { primary: 'retry', secondary: ['choose-agent'] },
  spawn_failed: { primary: 'retry', secondary: ['choose-agent'] },
  secure_env_transport_unavailable: {
    primary: 'reconnect-securely',
    secondary: ['choose-agent']
  },
  agent_configuration_changed: { primary: 'retry-current-settings', secondary: ['choose-agent'] },
  invalid_launch_snapshot: { primary: 'launch-current-settings', secondary: ['choose-agent'] },
  launch_capacity_exceeded: { primary: 'recover-capacity', secondary: ['choose-agent'] },
  launch_state_unknown: { primary: 'reconnect', secondary: ['forget-launch'] }
}

describe('resolveAgentLaunchRecoveryCard', () => {
  it('maps every failure code to its idle recovery-card row', () => {
    for (const code of ALL_FAILURE_CODES) {
      const model = resolveAgentLaunchRecoveryCard({ code }, { liveness: 'idle' })
      expect(model, code).toEqual(EXPECTED_IDLE[code])
      // The primary is never repeated in the secondary list.
      expect(model.secondary).not.toContain(model.primary)
    }
  })

  it('never offers Retry or Choose agent while a matched terminal may be live', () => {
    for (const code of ALL_FAILURE_CODES) {
      const live = resolveAgentLaunchRecoveryCard({ code }, { liveness: 'live-unattributed' })
      expect(live, code).toEqual({ primary: 'open-terminal', secondary: [] })
    }
  })

  it('offers Reconnect + Forget for every code when liveness is unknown', () => {
    for (const code of ALL_FAILURE_CODES) {
      const unknown = resolveAgentLaunchRecoveryCard({ code }, { liveness: 'unknown' })
      expect(unknown, code).toEqual({ primary: 'reconnect', secondary: ['forget-launch'] })
    }
  })

  it('never labels the invalid-snapshot recovery a plain Retry', () => {
    const model = resolveAgentLaunchRecoveryCard(
      { code: 'invalid_launch_snapshot' },
      { liveness: 'idle' }
    )
    expect(model.primary).toBe('launch-current-settings')
    expect(model.secondary).not.toContain('retry')
  })

  it('routes a corrupt definition to host repair and never to a safe fallback', () => {
    const model = resolveAgentLaunchRecoveryCard(
      { code: 'agent_definition_needs_repair' },
      { liveness: 'idle' }
    )
    expect(model.primary).toBe('repair-on-host')
    expect(model.secondary).not.toContain('retry')
  })
})
