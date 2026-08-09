import { describe, expect, it } from 'vitest'
import {
  resolveAgentStatusIdentity,
  shouldIgnoreNestedProviderSessionClaim,
  shouldSuppressInheritedTerminalStatus
} from './agent-status-identity'

describe('resolveAgentStatusIdentity', () => {
  it('keeps the active parent agent when a nested hook claims a different type', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: { agentType: 'claude', state: 'working', updatedAt: 1_000 },
        incoming: 'codex',
        now: 1_100
      })
    ).toEqual({ agentType: 'claude', inheritedFromActivePane: true })
  })
})

describe('shouldIgnoreNestedProviderSessionClaim', () => {
  it('ignores nested Codex claims while Claude is a fresh non-done parent (#10105)', () => {
    expect(
      shouldIgnoreNestedProviderSessionClaim({
        live: { agentType: 'claude', state: 'working', updatedAt: 1_000 },
        claimedAgent: 'codex',
        now: 1_100
      })
    ).toBe(true)
  })

  it('allows the same agent to refresh its own provider session', () => {
    expect(
      shouldIgnoreNestedProviderSessionClaim({
        live: { agentType: 'claude', state: 'working', updatedAt: 1_000 },
        claimedAgent: 'claude',
        now: 1_100
      })
    ).toBe(false)
  })

  it('allows a new agent after the parent turn is done', () => {
    expect(
      shouldIgnoreNestedProviderSessionClaim({
        live: { agentType: 'claude', state: 'done', updatedAt: 1_000 },
        claimedAgent: 'codex',
        now: 1_100
      })
    ).toBe(false)
  })
})

describe('shouldSuppressInheritedTerminalStatus', () => {
  it('suppresses nested done while identity was inherited from the parent pane', () => {
    expect(
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: true,
        incomingState: 'done'
      })
    ).toBe(true)
  })
})
