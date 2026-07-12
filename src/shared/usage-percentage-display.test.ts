import { describe, expect, it } from 'vitest'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay
} from './usage-percentage-display'

describe('usage percentage display', () => {
  it('defaults unknown persisted values to the current used-capacity behavior', () => {
    expect(normalizeUsagePercentageDisplay(undefined)).toBe('used')
    expect(normalizeUsagePercentageDisplay('left')).toBe('used')
  })

  it('shows either the provider value or its complement', () => {
    expect(getDisplayedUsagePercentage(6, 'used')).toBe(6)
    expect(getDisplayedUsagePercentage(6, 'remaining')).toBe(94)
  })

  it('rounds and bounds percentages for display', () => {
    expect(getDisplayedUsagePercentage(20.5, 'used')).toBe(21)
    expect(getDisplayedUsagePercentage(20.5, 'remaining')).toBe(80)
    expect(getDisplayedUsagePercentage(120, 'remaining')).toBe(0)
    expect(getDisplayedUsagePercentage(-20, 'used')).toBe(0)
    expect(getDisplayedUsagePercentage(Number.NaN, 'remaining')).toBe(0)
  })
})
