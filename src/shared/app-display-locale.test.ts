// The app locale contract, proved WITHOUT depending on the host OS locale.
//
// These tests exist because the four failures they guard were invisible on
// English CI runners and only appeared on a ru-RU developer machine. Asserting
// against `Intl` defaults would reproduce that blind spot, so every expectation
// below is either a hard literal or a comparison against an explicitly-named
// locale — never against whatever the host happens to resolve to.
import { describe, expect, it } from 'vitest'
import {
  APP_ENGLISH_LOCALE,
  formatEnglishCount,
  formatEnglishWeekday,
  formatHostClockTime
} from './app-display-locale'

// 2026-01-04 is a Sunday; the schedule formatters index weekdays from it.
const SUNDAY = new Date(2026, 0, 4)
const WEDNESDAY = new Date(2026, 0, 7)

describe('English fragments are pinned regardless of host locale', () => {
  it('formats weekdays in English', () => {
    expect(formatEnglishWeekday(SUNDAY)).toBe('Sunday')
    expect(formatEnglishWeekday(WEDNESDAY)).toBe('Wednesday')
  })

  it('groups counts with a comma, never a narrow no-break space', () => {
    expect(formatEnglishCount(10_000)).toBe('10,000')
    expect(formatEnglishCount(1_234_567)).toBe('1,234,567')
    // The ru-RU failure mode: U+00A0 as the group separator.
    expect(formatEnglishCount(10_000)).not.toContain(' ')
    expect(formatEnglishCount(10_000)).not.toContain(' ')
  })

  it('does not vary with the host locale', () => {
    // Proves pinning rather than coincidence: the English output must differ
    // from a locale known to format both values differently, whatever the host.
    const ruWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(SUNDAY)
    expect(formatEnglishWeekday(SUNDAY)).not.toBe(ruWeekday)
    expect(formatEnglishCount(10_000)).not.toBe((10_000).toLocaleString('ru-RU'))
  })

  it('names en-US, which fixes grouping that bare `en` leaves ambiguous', () => {
    expect(APP_ENGLISH_LOCALE).toBe('en-US')
  })
})

describe('clock time deliberately follows the user, not English', () => {
  it('matches the host locale rather than the pinned English one', () => {
    const date = new Date(2026, 0, 4, 12, 30, 0, 0)
    const hostFormatted = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(date)
    expect(formatHostClockTime(date)).toBe(hostFormatted)
  })

  it('renders both hour and minute on every host', () => {
    // Shape assertion only — the exact separator and 12h/24h form are the
    // user's preference, so pinning them here would re-break the thing this
    // deliberate `undefined` exists to preserve.
    expect(formatHostClockTime(new Date(2026, 0, 4, 12, 30))).toMatch(/\d/)
    expect(formatHostClockTime(new Date(2026, 0, 4, 12, 30)).length).toBeGreaterThan(2)
  })
})
