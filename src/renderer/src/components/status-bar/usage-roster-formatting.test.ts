import { describe, expect, it } from 'vitest'
import {
  formatCreditAmount,
  formatPlanLabel,
  formatWindowAmounts,
  formatWindowAmountsCompact,
  usageTextColorClass
} from './usage-roster-formatting'
import type { RateLimitWindow } from '../../../../shared/rate-limit-types'

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

describe('formatCreditAmount', () => {
  it('prefixes whole values with $ and drops trailing decimals', () => {
    expect(formatCreditAmount(580)).toBe('$580')
    expect(formatCreditAmount(1000)).toBe('$1,000')
  })

  it('keeps one decimal for fractional credits', () => {
    expect(formatCreditAmount(142.5)).toBe('$142.5')
    expect(formatCreditAmount(0.4)).toBe('$0.4')
    expect(formatCreditAmount(142.56)).toBe('$142.6')
  })

  it('returns null for missing or non-finite values', () => {
    expect(formatCreditAmount(null)).toBeNull()
    expect(formatCreditAmount(undefined)).toBeNull()
    expect(formatCreditAmount(Number.NaN)).toBeNull()
  })
})

describe('formatWindowAmounts', () => {
  function window(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
    return {
      usedPercent: 42,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null,
      ...overrides
    }
  }

  it('renders labeled remaining | used when both amounts exist', () => {
    expect(formatWindowAmounts(window({ remainingAmount: 580, usedAmount: 420 }))).toBe(
      '$580 left | $420 used'
    )
  })

  it('falls back to em-dashes for a missing side', () => {
    expect(formatWindowAmounts(window({ remainingAmount: 580 }))).toBe('$580 left | —')
    expect(formatWindowAmounts(window({ usedAmount: 420 }))).toBe('— | $420 used')
  })

  it('returns null when neither amount exists', () => {
    expect(formatWindowAmounts(window())).toBeNull()
  })
})

describe('formatWindowAmountsCompact', () => {
  function window(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
    return {
      usedPercent: 42,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null,
      ...overrides
    }
  }

  it('renders $ amounts without labels', () => {
    expect(formatWindowAmountsCompact(window({ remainingAmount: 580, usedAmount: 420 }))).toBe(
      '$580 | $420'
    )
    expect(formatWindowAmountsCompact(window({ remainingAmount: 580 }))).toBe('$580 | —')
  })

  it('returns null when neither amount exists', () => {
    expect(formatWindowAmountsCompact(window())).toBeNull()
  })
})
