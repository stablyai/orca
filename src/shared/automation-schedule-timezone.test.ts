import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

afterEach(() => vi.unstubAllEnvs())

describe('automation occurrence timezones', () => {
  it.each(['UTC', 'America/Los_Angeles'])('uses the saved timezone on a %s host', (host) => {
    vi.stubEnv('TZ', host)
    const start = Date.parse('2026-09-01T00:00:00Z')
    for (const rule of ['0 9 * * *', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0']) {
      expect(
        nextAutomationOccurrenceAfter(
          rule,
          start,
          Date.parse('2026-09-06T00:00:00Z'),
          'Asia/Shanghai'
        )
      ).toBe(Date.parse('2026-09-06T01:00:00Z'))
      expect(
        latestAutomationOccurrenceAtOrBefore(
          rule,
          start,
          Date.parse('2026-09-06T02:00:00Z'),
          'Asia/Shanghai'
        )
      ).toBe(Date.parse('2026-09-06T01:00:00Z'))
    }
    expect(process.env.TZ).toBe(host)
  })

  it('uses local weekdays and fractional-hour offsets', () => {
    vi.stubEnv('TZ', 'UTC')
    const now = Date.parse('2026-09-06T20:00:00Z')
    for (const rule of ['0 9 * * 1', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0']) {
      expect(nextAutomationOccurrenceAfter(rule, 0, now, 'Asia/Kathmandu')).toBe(
        Date.parse('2026-09-07T03:15:00Z')
      )
    }
    expect(nextAutomationOccurrenceAfter('FREQ=HOURLY;BYMINUTE=0', 0, now, 'Asia/Kathmandu')).toBe(
      Date.parse('2026-09-06T20:15:00Z')
    )
  })

  it('skips nonexistent spring-forward times', () => {
    for (const rule of ['30 2 * * *', 'FREQ=DAILY;BYHOUR=2;BYMINUTE=30']) {
      expect(
        nextAutomationOccurrenceAfter(
          rule,
          0,
          Date.parse('2026-03-08T00:00:00-05:00'),
          'America/New_York'
        )
      ).toBe(Date.parse('2026-03-09T02:30:00-04:00'))
    }
  })

  it('finds both instants of a repeated local minute', () => {
    const first = Date.parse('2026-11-01T01:30:00-04:00')
    const second = Date.parse('2026-11-01T01:30:00-05:00')
    for (const rule of ['30 1 * * *', 'FREQ=DAILY;BYHOUR=1;BYMINUTE=30']) {
      expect(nextAutomationOccurrenceAfter(rule, 0, first, 'America/New_York')).toBe(second)
      expect(latestAutomationOccurrenceAtOrBefore(rule, 0, second, 'America/New_York')).toBe(second)
      expect(
        latestAutomationOccurrenceAtOrBefore(rule, first + 1, second - 1, 'America/New_York')
      ).toBeNull()
    }
  })

  it('finds a leap day across a non-leap century without scanning every minute', () => {
    expect(
      nextAutomationOccurrenceAfter(
        '0 9 29 2 *',
        0,
        Date.parse('2096-03-01T00:00:00Z'),
        'Asia/Shanghai'
      )
    ).toBe(Date.parse('2104-02-29T01:00:00Z'))
  })

  it('rejects invalid timezones when computing occurrences', () => {
    const timezone = 'Mars/Olympus_Mons'
    expect(() => nextAutomationOccurrenceAfter('0 9 * * *', 0, Date.now(), timezone)).toThrow()
  })
})
