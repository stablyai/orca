import { expect, it } from 'vitest'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'

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
