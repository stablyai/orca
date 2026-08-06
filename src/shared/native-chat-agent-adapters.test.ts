import { describe, expect, it } from 'vitest'
import type { NativeChatAgentAdapter } from './native-chat-agent-adapters'
import {
  createNativeChatAgentAdapterRegistry,
  NATIVE_CHAT_AGENT_ADAPTERS
} from './native-chat-agent-adapters'

describe('native chat agent adapter registry', () => {
  it('describes the built-in agent families and interaction policies', () => {
    expect(NATIVE_CHAT_AGENT_ADAPTERS.list()).toHaveLength(4)
    expect(NATIVE_CHAT_AGENT_ADAPTERS.get('openclaude')).toMatchObject({
      transcriptAgent: 'claude',
      askAnswerMode: 'step-lines',
      skillSourceOwner: 'claude'
    })
    expect(NATIVE_CHAT_AGENT_ADAPTERS.get('codex')).toMatchObject({
      transcriptAgent: 'codex',
      askAnswerMode: 'step-lines',
      skillPrefix: '$'
    })
    expect(NATIVE_CHAT_AGENT_ADAPTERS.get('cursor')).toBeNull()
  })

  it('rejects duplicate agent ownership', () => {
    const adapter = NATIVE_CHAT_AGENT_ADAPTERS.get('codex') as NativeChatAgentAdapter
    expect(() => createNativeChatAgentAdapterRegistry([adapter, adapter])).toThrow(
      'Duplicate native chat agent adapter: codex'
    )
  })

  it('snapshots adapter descriptors before exposing them', () => {
    const adapter = {
      ...NATIVE_CHAT_AGENT_ADAPTERS.get('codex')!
    } as NativeChatAgentAdapter
    const registry = createNativeChatAgentAdapterRegistry([adapter])

    expect(registry.get('codex')).not.toBe(adapter)
    expect(Object.isFrozen(registry.get('codex'))).toBe(true)
    expect(Object.isFrozen(registry.list())).toBe(true)
    expect(Object.isFrozen(registry)).toBe(true)
  })
})
