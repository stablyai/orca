import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIntlLocale } = vi.hoisted(() => ({ mockIntlLocale: { value: 'en' } }))

vi.mock('./i18n', () => ({ getIntlLocale: () => mockIntlLocale.value }))

import {
  formatUiRelativeTime,
  formatUiRelativeTimeFromDate,
  getUiRelativeTimeFormatter
} from './relative-time-format'

beforeEach(() => {
  mockIntlLocale.value = 'en'
})

describe('getUiRelativeTimeFormatter', () => {
  it('formats with the configured UI language instead of the OS locale', () => {
    expect(getUiRelativeTimeFormatter().format(-1, 'day')).toBe('yesterday')
  })

  it('reuses the cached formatter while the language is unchanged', () => {
    expect(getUiRelativeTimeFormatter()).toBe(getUiRelativeTimeFormatter())
  })

  it('rebuilds the formatter after a runtime language switch', () => {
    const english = getUiRelativeTimeFormatter()
    mockIntlLocale.value = 'ko'
    const korean = getUiRelativeTimeFormatter()
    expect(korean).not.toBe(english)
    expect(korean.format(-1, 'day')).toBe('어제')
  })

  // getIntlLocale() already maps the synthetic plugin<hex> resource language to a real BCP-47 tag,
  // so the constructor never sees a value Intl would reject.
  it('formats in the tag a plugin language pack resolves to', () => {
    mockIntlLocale.value = 'ja'
    expect(getUiRelativeTimeFormatter().format(-1, 'day')).toBe('昨日')
  })
})

describe('formatUiRelativeTime', () => {
  it('picks the minute/hour/day unit from the signed millisecond delta', () => {
    expect(formatUiRelativeTime(-5 * 60_000)).toBe('5 minutes ago')
    expect(formatUiRelativeTime(-3 * 3_600_000)).toBe('3 hours ago')
    expect(formatUiRelativeTime(-2 * 86_400_000)).toBe('2 days ago')
  })

  it('formats future deltas', () => {
    expect(formatUiRelativeTime(2 * 86_400_000)).toBe('in 2 days')
  })
})

describe('formatUiRelativeTimeFromDate', () => {
  it('returns the fallback for an invalid date', () => {
    expect(formatUiRelativeTimeFromDate('not-a-date')).toBe('recently')
    expect(formatUiRelativeTimeFromDate('not-a-date', 'unknown')).toBe('unknown')
  })
})
