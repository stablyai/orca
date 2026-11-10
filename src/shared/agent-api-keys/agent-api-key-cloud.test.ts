import { describe, expect, it } from 'vitest'
import {
  agentApiKeyCloudEligible,
  agentApiKeyCloudRowState,
  agentApiKeyRemoveAsksAboutAccount,
  type AgentApiKeysCloudState
} from './agent-api-key-cloud'

const ALL = { kind: 'all' } as const
const signedIn: AgentApiKeysCloudState = { signedIn: true, synced: ['a'], managed: ['a', 'b'] }

describe('agentApiKeyCloudRowState', () => {
  it('reads as today when signed out or when the key is scoped to some hosts', () => {
    expect(
      agentApiKeyCloudRowState({ id: 'a', envName: 'ANTHROPIC_API_KEY', hostScope: ALL }, undefined)
    ).toBe('none')
    expect(
      agentApiKeyCloudRowState(
        { id: 'a', envName: 'ANTHROPIC_API_KEY', hostScope: ALL },
        { signedIn: false, synced: ['a'], managed: ['a'] }
      )
    ).toBe('none')
    expect(
      agentApiKeyCloudRowState(
        { id: 'c', envName: 'ANTHROPIC_API_KEY', hostScope: { kind: 'hosts', hostIds: ['local'] } },
        signedIn
      )
    ).toBe('none')
  })

  it('names a key whose account copy is out of date as stale, whatever its scope now', () => {
    expect(
      agentApiKeyCloudRowState(
        { id: 'b', envName: 'OPENAI_API_KEY', hostScope: { kind: 'hosts', hostIds: ['local'] } },
        signedIn
      )
    ).toBe('stale')
  })

  it('names synced, local and not-swappable keys', () => {
    expect(
      agentApiKeyCloudRowState({ id: 'a', envName: 'ANTHROPIC_API_KEY', hostScope: ALL }, signedIn)
    ).toBe('synced')
    expect(
      agentApiKeyCloudRowState({ id: 'd', envName: 'OPENAI_API_KEY', hostScope: ALL }, signedIn)
    ).toBe('local')
    expect(
      agentApiKeyCloudRowState(
        { id: 'c', envName: 'AWS_BEARER_TOKEN_BEDROCK', hostScope: ALL },
        signedIn
      )
    ).toBe('not-swappable')
  })

  it('only offers account removal for keys this computer wrote, while signed in', () => {
    expect(agentApiKeyRemoveAsksAboutAccount({ id: 'b' }, signedIn)).toBe(true)
    expect(agentApiKeyRemoveAsksAboutAccount({ id: 'c' }, signedIn)).toBe(false)
    expect(agentApiKeyRemoveAsksAboutAccount({ id: 'a' }, { ...signedIn, signedIn: false })).toBe(
      false
    )
  })

  it('is eligible only for every-host keys the proxy swaps', () => {
    expect(agentApiKeyCloudEligible({ envName: 'GEMINI_API_KEY', hostScope: ALL })).toBe(true)
    expect(agentApiKeyCloudEligible({ envName: 'AWS_BEARER_TOKEN_BEDROCK', hostScope: ALL })).toBe(
      false
    )
    expect(
      agentApiKeyCloudEligible({
        envName: 'GEMINI_API_KEY',
        hostScope: { kind: 'hosts', hostIds: ['local'] }
      })
    ).toBe(false)
  })
})
