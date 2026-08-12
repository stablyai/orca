import { describe, expect, it } from 'vitest'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'

describe('chooseInitialContinuationAgent', () => {
  it('keeps the source Agent when it is available', () => {
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex', 'claude'],
        sourceAgent: 'claude',
        defaultAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('falls back to the saved default and then the first available Agent', () => {
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex', 'claude'],
        sourceAgent: 'gemini',
        defaultAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex'],
        sourceAgent: null,
        defaultAgent: 'blank'
      })
    ).toBe('codex')
  })
})
