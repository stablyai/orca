import { describe, expect, it } from 'vitest'
import {
  formatPlanLabel,
  formatRelativeTime,
  formatUsageUpdatedLabel,
  usageTextColorClass
} from './usage-roster-formatting'

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

describe('formatRelativeTime', () => {
  const now = 1_000_000_000

  it('uses 60s / 60m thresholds for just now, minutes, and hours', () => {
    expect(formatRelativeTime(now, now)).toBe('just now')
    expect(formatRelativeTime(now - 59_999, now)).toBe('just now')
    expect(formatRelativeTime(now - 60_000, now)).toBe('1m ago')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('59m ago')
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1h ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
  })
})

describe('formatUsageUpdatedLabel', () => {
  const now = 1_000_000_000

  it('returns null when there is no usable timestamp', () => {
    expect(formatUsageUpdatedLabel(0, now)).toBeNull()
    expect(formatUsageUpdatedLabel(Number.NaN, now)).toBeNull()
  })

  it('prefixes the shared relative-time helper', () => {
    expect(formatUsageUpdatedLabel(now - 30_000, now)).toBe('Updated just now')
    expect(formatUsageUpdatedLabel(now - 5 * 60_000, now)).toBe(
      `Updated ${formatRelativeTime(now - 5 * 60_000, now)}`
    )
    expect(formatUsageUpdatedLabel(now - 3 * 3_600_000, now)).toBe('Updated 3h ago')
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
