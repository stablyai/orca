import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'

import { everyText, upcomingShort } from './bot-upcoming-copy'

describe('everyText', () => {
  it('says the schedule the setting runs on, days and hours included', () => {
    expect(everyText({ every: 'every-4h', weekdaysOnly: true })).toBe(
      'weekdays, 8 AM to 8 PM, every 4 hours'
    )
    expect(everyText({ every: 'twice-daily', weekdaysOnly: false })).toBe(
      'twice a day, 8 AM and 1 PM'
    )
  })
})

describe('upcomingShort', () => {
  // Wed Nov 18 2026, 6:18 PM local.
  const now = new Date(2026, 10, 18, 18, 18).getTime()
  const at = (day: number, hour: number, minute = 0): number =>
    new Date(2026, 10, day, hour, minute).getTime()

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('counts minutes under an hour, never "in 0m" or "in 60m"', () => {
    expect(upcomingShort(now + 12 * 60_000, now)).toBe('in 12m')
    expect(upcomingShort(now + 20_000, now)).toBe('in 1m')
    expect(upcomingShort(now + 59.5 * 60_000, now)).toBe('in 59m')
  })

  it('says the clock later today, dropping ":00"', () => {
    expect(upcomingShort(at(18, 19, 30), now)).toBe('7:30 PM')
    expect(upcomingShort(at(18, 21), now)).toBe('9 PM')
  })

  it('puts the weekday on tomorrow, so it never reads as today', () => {
    expect(upcomingShort(at(19, 3), now)).toBe('Thu 3 AM')
    expect(upcomingShort(at(19, 18, 15), now)).toBe('Thu 6:15 PM')
  })

  it('says only the weekday within six days, then the date', () => {
    expect(upcomingShort(at(20, 9), now)).toBe('Fri')
    expect(upcomingShort(at(24, 9), now)).toBe('Tue')
    expect(upcomingShort(at(25, 9), now)).toBe('Nov 25')
    expect(upcomingShort(new Date(2026, 11, 2, 9).getTime(), now)).toBe('Dec 2')
  })

  it('formats in the UI language', async () => {
    await i18n.changeLanguage('de')
    expect(upcomingShort(at(18, 21), now)).toBe('21 Uhr')
    expect(upcomingShort(at(25, 9), now)).toBe('25. Nov.')
    expect(upcomingShort(now + 12 * 60_000, now)).toBe(
      new Intl.RelativeTimeFormat('de', { style: 'narrow', numeric: 'always' }).format(12, 'minute')
    )
  })
})
