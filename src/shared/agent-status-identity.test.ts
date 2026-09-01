import { describe, expect, it } from 'vitest'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from './agent-status-identity'

const CUSTOM_COMMAND_CODE = 'custom-agent:command-code:5f9f1c3a-1111-4222-8333-444455556666'
const CUSTOM_COMMAND_CODE_B = 'custom-agent:command-code:6a0f1c3a-2222-4222-8333-444455556666'
const CUSTOM_CLAUDE = 'custom-agent:claude:5f9f1c3a-1111-4222-8333-444455556666'

describe('resolveAgentStatusIdentity', () => {
  it('treats a base-typed event on a custom-seeded row as the same agent, keeping the custom label', () => {
    const result = resolveAgentStatusIdentity({
      existing: { agentType: CUSTOM_COMMAND_CODE, state: 'working', updatedAt: 1_000 },
      incoming: 'command-code',
      now: 2_000
    })
    expect(result).toEqual({ agentType: CUSTOM_COMMAND_CODE, inheritedFromActivePane: false })
  })

  it('does not suppress a done event whose base matches the seeded custom row', () => {
    const identity = resolveAgentStatusIdentity({
      existing: { agentType: CUSTOM_COMMAND_CODE, state: 'working', updatedAt: 1_000 },
      incoming: 'command-code',
      now: 2_000
    })
    expect(
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: 'done'
      })
    ).toBe(false)
  })

  it('adopts an incoming custom id over its own base', () => {
    const result = resolveAgentStatusIdentity({
      existing: { agentType: 'command-code', state: 'working', updatedAt: 1_000 },
      incoming: CUSTOM_COMMAND_CODE,
      now: 2_000
    })
    expect(result).toEqual({ agentType: CUSTOM_COMMAND_CODE, inheritedFromActivePane: false })
  })

  it('still protects a fresh row from a different-base nested child', () => {
    const result = resolveAgentStatusIdentity({
      existing: { agentType: CUSTOM_COMMAND_CODE, state: 'working', updatedAt: 1_000 },
      incoming: 'claude',
      now: 2_000
    })
    expect(result).toEqual({ agentType: CUSTOM_COMMAND_CODE, inheritedFromActivePane: true })
  })

  it('keeps two distinct custom ids on one base distinct (inheritance rule applies)', () => {
    const result = resolveAgentStatusIdentity({
      existing: { agentType: CUSTOM_COMMAND_CODE, state: 'working', updatedAt: 1_000 },
      incoming: CUSTOM_COMMAND_CODE_B,
      now: 2_000
    })
    expect(result).toEqual({ agentType: CUSTOM_COMMAND_CODE, inheritedFromActivePane: true })
  })

  it('does not merge a custom id with a different base agent', () => {
    const result = resolveAgentStatusIdentity({
      existing: { agentType: CUSTOM_CLAUDE, state: 'working', updatedAt: 1_000 },
      incoming: 'command-code',
      now: 2_000
    })
    expect(result).toEqual({ agentType: CUSTOM_CLAUDE, inheritedFromActivePane: true })
  })
})
