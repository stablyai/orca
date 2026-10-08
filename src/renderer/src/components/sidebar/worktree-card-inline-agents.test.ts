import { describe, expect, it } from 'vitest'
import { shouldShowInlineAgentList } from './worktree-card-inline-agents'

describe('shouldShowInlineAgentList', () => {
  // Regression: the expanded compact project showed nothing when "Agent statuses" was off.
  it('lists agents for the expanded compact project even without the card property', () => {
    expect(
      shouldShowInlineAgentList({
        forceInlineAgents: true,
        cardProps: ['status', 'pr'],
        newCardStyle: true,
        compactCards: false
      })
    ).toBe(true)
    expect(
      shouldShowInlineAgentList({
        forceInlineAgents: true,
        cardProps: [],
        newCardStyle: false,
        compactCards: true
      })
    ).toBe(true)
  })

  it('otherwise follows the card property and card layout', () => {
    const base = { forceInlineAgents: false, newCardStyle: false, compactCards: false }
    expect(shouldShowInlineAgentList({ ...base, cardProps: ['status'] })).toBe(false)
    expect(shouldShowInlineAgentList({ ...base, cardProps: ['inline-agents'] })).toBe(true)
    expect(
      shouldShowInlineAgentList({ ...base, cardProps: ['inline-agents'], compactCards: true })
    ).toBe(false)
  })
})
