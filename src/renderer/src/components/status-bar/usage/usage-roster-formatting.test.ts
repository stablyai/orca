import { describe, expect, it } from 'vitest'
import { formatPlanLabel } from './usage-roster-formatting'

describe('formatPlanLabel', () => {
  it('maps renamed Claude Max tiers', () => {
    expect(formatPlanLabel('max_20x')).toBe('Ultra')
    expect(formatPlanLabel('max_5x')).toBe('Max')
  })

  it('title-cases other plans and drops unknown', () => {
    expect(formatPlanLabel('pro')).toBe('Pro')
    expect(formatPlanLabel('chatgpt_plus')).toBe('ChatGPT Plus')
    expect(formatPlanLabel('unknown')).toBeNull()
  })
})
