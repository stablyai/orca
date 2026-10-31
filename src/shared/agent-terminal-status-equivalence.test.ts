import { describe, expect, it } from 'vitest'
import { terminalStatusPayloadMatchesHook } from './agent-terminal-status-equivalence'

describe('terminalStatusPayloadMatchesHook', () => {
  const hook = {
    state: 'working' as const,
    workingMode: 'monitoring' as const,
    prompt: 'watch tests',
    agentType: 'claude'
  }

  it('accepts an otherwise equivalent terminal payload that omits hook-owned mode', () => {
    expect(
      terminalStatusPayloadMatchesHook(hook, {
        state: 'working',
        prompt: 'watch tests',
        agentType: 'claude'
      })
    ).toBe(true)
  })

  it('rejects a terminal payload from a different turn', () => {
    expect(
      terminalStatusPayloadMatchesHook(hook, {
        state: 'working',
        prompt: 'fix tests',
        agentType: 'claude'
      })
    ).toBe(false)
  })
})
