// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { classifyAgentBaseIdentity, resolveAgentBaseIdentity } from './agent-base-identity'
import type { CustomTuiAgent, DeletedCustomTuiAgent } from '../../../shared/types'

const CUSTOM_CODEX_ID = 'custom-agent:codex:0f9f1c22-2a1b-4c33-9a44-55d6e7f8a900' as const

function customAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: CUSTOM_CODEX_ID,
    baseAgent: 'codex',
    label: 'Codex (review)',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

describe('resolveAgentBaseIdentity', () => {
  it('passes a built-in through unchanged', () => {
    expect(
      resolveAgentBaseIdentity('codex', { customTuiAgents: [], deletedCustomTuiAgents: [] })
    ).toBe('codex')
  })

  it('resolves a live custom agent to its base', () => {
    expect(
      resolveAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [customAgent()],
        deletedCustomTuiAgents: []
      })
    ).toBe('codex')
  })

  it('resolves a deleted custom agent through its tombstone', () => {
    const tombstone: DeletedCustomTuiAgent = {
      id: CUSTOM_CODEX_ID,
      baseAgent: 'codex',
      label: 'Codex (review)',
      deletedAt: 0
    }
    expect(
      resolveAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [],
        deletedCustomTuiAgents: [tombstone]
      })
    ).toBe('codex')
  })

  it('leaves an unprovable custom id alone rather than reading its syntax', () => {
    // The catalog-only accessor is what `pty-connection` call sites use; widening
    // it would change what they publish for a tombstone-less custom id.
    expect(
      resolveAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [],
        deletedCustomTuiAgents: []
      })
    ).toBe(CUSTOM_CODEX_ID)
  })

  it('reads a base the catalog proves over the one the id encodes', () => {
    expect(
      resolveAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [customAgent({ baseAgent: 'claude' })],
        deletedCustomTuiAgents: []
      })
    ).toBe('claude')
  })

  it('passes non-catalog agent strings through so per-agent preferences keep the requested id', () => {
    expect(resolveAgentBaseIdentity('unknown', null)).toBe('unknown')
    expect(resolveAgentBaseIdentity(undefined, null)).toBeUndefined()
  })

  it('tolerates missing settings', () => {
    expect(resolveAgentBaseIdentity(CUSTOM_CODEX_ID, null)).toBe(CUSTOM_CODEX_ID)
    expect(resolveAgentBaseIdentity('codex', undefined)).toBe('codex')
  })
})

describe('classifyAgentBaseIdentity', () => {
  it('prefers the base the catalog proves over the one the id encodes', () => {
    expect(
      classifyAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [customAgent({ baseAgent: 'claude' })],
        deletedCustomTuiAgents: []
      })
    ).toBe('claude')
  })

  it('falls back to the id syntax when neither definition nor tombstone survives', () => {
    // Why the fallback is worth its risk HERE: leaving the pane unclassified is
    // what lets it keep taking keystrokes on the account the user switched away
    // from. The catalog-only accessor deliberately does not do this.
    expect(
      classifyAgentBaseIdentity(CUSTOM_CODEX_ID, {
        customTuiAgents: [],
        deletedCustomTuiAgents: []
      })
    ).toBe('codex')
    expect(classifyAgentBaseIdentity(CUSTOM_CODEX_ID, null)).toBe('codex')
  })

  it('still passes non-catalog agent strings through', () => {
    expect(classifyAgentBaseIdentity('unknown', null)).toBe('unknown')
    expect(classifyAgentBaseIdentity(undefined, null)).toBeUndefined()
  })
})
