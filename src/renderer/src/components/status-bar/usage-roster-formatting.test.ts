import { describe, expect, it } from 'vitest'
import { formatPlanLabel, usageTextColorClass } from './usage-roster-formatting'

describe('formatPlanLabel', () => {
  it('capitalizes a single-word plan', () => {
    expect(formatPlanLabel('plus')).toBe('Plus')
    expect(formatPlanLabel('pro')).toBe('Pro')
    expect(formatPlanLabel('business')).toBe('Business')
  })

  it('title-cases multi-token plans across separators', () => {
    expect(formatPlanLabel('chatgpt_business')).toBe('ChatGPT Business')
    expect(formatPlanLabel('CHATGPT_PLUS')).toBe('ChatGPT Plus')
    expect(formatPlanLabel('team-plus')).toBe('Team Plus')
    expect(formatPlanLabel('pro trial')).toBe('Pro Trial')
  })

  it('returns null when there is no usable plan', () => {
    expect(formatPlanLabel(null)).toBeNull()
    expect(formatPlanLabel(undefined)).toBeNull()
    expect(formatPlanLabel('')).toBeNull()
    expect(formatPlanLabel('   ')).toBeNull()
  })
})

describe('usageTextColorClass', () => {
  it('stays neutral below the 60% caution line', () => {
    expect(usageTextColorClass(0)).toBe('text-foreground')
    expect(usageTextColorClass(59)).toBe('text-foreground')
  })

  it('turns amber in the 60–79% caution band', () => {
    expect(usageTextColorClass(60)).toBe('text-yellow-500')
    expect(usageTextColorClass(79)).toBe('text-yellow-500')
  })

  it('turns red at the 80% critical line and above', () => {
    expect(usageTextColorClass(80)).toBe('text-red-500')
    expect(usageTextColorClass(100)).toBe('text-red-500')
  })
})
