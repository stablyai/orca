import { describe, expect, it } from 'vitest'
import {
  detectAgentRateLimitOutput,
  type AgentRateLimitDetectionState
} from './agent-rate-limit-detection'

function createState(): AgentRateLimitDetectionState {
  return { tail: '' }
}

describe('agent rate limit detection', () => {
  it('detects split Codex account limit output', () => {
    const state = createState()

    expect(detectAgentRateLimitOutput('codex', 'Error: rate ', state)).toBe(false)
    expect(detectAgentRateLimitOutput('codex', 'limit exceeded. Try later.', state)).toBe(true)
  })

  it('detects ANSI-wrapped Claude usage limit output', () => {
    expect(
      detectAgentRateLimitOutput(
        'claude',
        '\x1b[31mYou have reached your weekly usage limit\x1b[0m',
        createState()
      )
    ).toBe(true)
  })

  it('does not treat context window limits as account limits', () => {
    expect(
      detectAgentRateLimitOutput(
        'codex',
        'The conversation is too long for the current context window.',
        createState()
      )
    ).toBe(false)
  })
})
