import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

afterEach(() => vi.unstubAllEnvs())

describe('automation calendar-day iteration across DST', () => {
  it.each([
    {
      timezone: 'America/New_York',
      now: '2026-03-09T00:30:00-04:00',
      expected: '2026-03-08T23:30:00-04:00'
    },
    {
      timezone: 'Australia/Lord_Howe',
      now: '2026-10-05T00:15:00+11:00',
      expected: '2026-10-04T23:30:00+11:00'
    }
  ])(
    'finds the previous calendar day after spring-forward in $timezone',
    ({ timezone, now, expected }) => {
      vi.stubEnv('TZ', timezone)
      for (const rrule of [
        'FREQ=DAILY;BYHOUR=23;BYMINUTE=30',
        'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=30'
      ]) {
        expect(
          latestAutomationOccurrenceAtOrBefore(
            rrule,
            Date.parse('2026-01-01T00:00:00Z'),
            Date.parse(now)
          )
        ).toBe(Date.parse(expected))
      }
    }
  )

  it('finds the next calendar day across fall-back and respects dtstart', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const rrule = 'FREQ=DAILY;BYHOUR=23;BYMINUTE=30'
    const start = Date.parse('2026-11-01T23:45:00-05:00')
    const expected = Date.parse('2026-11-02T23:30:00-05:00')
    expect(nextAutomationOccurrenceAfter(rrule, start, start)).toBe(expected)
    expect(latestAutomationOccurrenceAtOrBefore(rrule, start, expected - 1)).toBeNull()
    expect(latestAutomationOccurrenceAtOrBefore(rrule, start, expected)).toBe(expected)
  })
})
