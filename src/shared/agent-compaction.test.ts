import { describe, expect, it } from 'vitest'
import {
  AGENT_COMPACT_COMMAND,
  COMPACTABLE_AGENT_TYPES,
  isAgentCompactionSupported
} from './agent-compaction'

describe('agent compaction', () => {
  it('uses the provider-native command for every supported Native Chat harness', () => {
    expect(AGENT_COMPACT_COMMAND).toBe('/compact')
    expect(COMPACTABLE_AGENT_TYPES).toEqual(['claude', 'openclaude', 'codex', 'grok'])
    expect(COMPACTABLE_AGENT_TYPES.every(isAgentCompactionSupported)).toBe(true)
    expect(isAgentCompactionSupported('gemini')).toBe(false)
  })
})
