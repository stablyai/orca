import { describe, expect, it } from 'vitest'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'

describe('chooseInitialContinuationAgent', () => {
  it('keeps the source Agent when it is available', () => {
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex', 'claude'],
        automaticAgents: ['codex', 'claude'],
        sourceAgent: 'claude',
        defaultAgent: 'codex'
      })
    ).toBe('claude')
  })

  it('falls back to the saved default and then the first available Agent', () => {
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex', 'claude'],
        automaticAgents: ['codex', 'claude'],
        sourceAgent: 'gemini',
        defaultAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      chooseInitialContinuationAgent({
        availableAgents: ['codex'],
        automaticAgents: ['codex'],
        sourceAgent: null,
        defaultAgent: 'blank'
      })
    ).toBe('codex')
  })
})

it('does not automatically choose an offered-only chat, but preserves source and default intent', () => {
  const pick = (sourceAgent: 'antigravity' | null, defaultAgent: unknown) =>
    chooseInitialContinuationAgent({
      availableAgents: ['antigravity'],
      automaticAgents: [],
      sourceAgent,
      defaultAgent
    })
  expect(pick(null, null)).toBeNull()
  expect(pick('antigravity', null)).toBe('antigravity')
  expect(pick(null, 'antigravity')).toBe('antigravity')
})
