import { describe, expect, it } from 'vitest'
import {
  clampUsedPercent,
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
    // Complement is taken from the rounded used value (21), so remaining is 79 —
    // it must not round the complement independently to 80. (#7574)
    expect(getDisplayedUsagePercentage(20.5, 'remaining')).toBe(79)
    expect(getDisplayedUsagePercentage(120, 'remaining')).toBe(0)
    expect(getDisplayedUsagePercentage(-20, 'used')).toBe(0)
    expect(getDisplayedUsagePercentage(Number.NaN, 'remaining')).toBe(0)
  })

  it('clamps non-finite provider values to 0 for bar width and labels', () => {
    // Why: Math.round/min/max propagate NaN into CSS width (`NaN%`) and copy.
    expect(clampUsedPercent(Number.NaN)).toBe(0)
    expect(clampUsedPercent(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampUsedPercent(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('agrees whether given a raw or pre-clamped used percent (#7574)', () => {
    // Finite inputs only: non-finite clamp→0 vs getDisplayedUsagePercentage→0
    // diverge for remaining (100 vs 0), so that case is covered separately above.
    for (const raw of [20.5, 6.5, 79.5, 0.5, 99.5]) {
      for (const display of ['used', 'remaining'] as const) {
        expect(getDisplayedUsagePercentage(clampUsedPercent(raw), display)).toBe(
          getDisplayedUsagePercentage(raw, display)
        )
      }
    }
  })
})
