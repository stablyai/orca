import { describe, expect, it } from 'vitest'
import {
  buildAutomationRrule,
  formatAutomationSchedule,
  isValidAutomationSchedule,
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter,
  parseAutomationRrule,
  tryParseAutomationRrule
} from './automation-schedules'

describe('automation schedules', () => {
  it('uses the latest overdue hourly occurrence for missed-run grace decisions', () => {
    const rrule = buildAutomationRrule({ preset: 'hourly', hour: 9, minute: 0 })
    const latest = latestAutomationOccurrenceAtOrBefore(
      rrule,
      new Date('2026-05-12T00:00:00').getTime(),
      new Date('2026-05-13T14:20:00').getTime()
    )
    expect(latest).toBe(new Date('2026-05-13T14:00:00').getTime())
  })

  it('computes weekday schedules without returning weekend candidates', () => {
    const rrule = buildAutomationRrule({ preset: 'weekdays', hour: 9, minute: 30 })
    const next = nextAutomationOccurrenceAfter(
      rrule,
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(new Date(next).getDay()).toBe(1)
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getMinutes()).toBe(30)
  })

  it('round-trips a weekly schedule for editing', () => {
    const rrule = buildAutomationRrule({ preset: 'weekly', hour: 16, minute: 45, dayOfWeek: 3 })
    expect(parseAutomationRrule(rrule)).toEqual({
      preset: 'weekly',
      hour: 16,
      minute: 45,
      dayOfWeek: 3
    })
  })

  it('round-trips Sunday weekly schedules without coercing them to Monday', () => {
    const rrule = buildAutomationRrule({ preset: 'weekly', hour: 10, minute: 15, dayOfWeek: 0 })
    expect(parseAutomationRrule(rrule)).toEqual({
      preset: 'weekly',
      hour: 10,
      minute: 15,
      dayOfWeek: 0
    })
  })

  it('rejects malformed weekly BYDAY instead of remapping to Sunday', () => {
    expect(() => parseAutomationRrule('FREQ=WEEKLY;BYDAY=NO;BYHOUR=10;BYMINUTE=15')).toThrow(
      'Invalid recurrence day.'
    )
    expect(tryParseAutomationRrule('FREQ=WEEKLY;BYDAY=MO,NO;BYHOUR=10;BYMINUTE=15')).toBeNull()
  })

  it('formats invalid schedules with a safe fallback label', () => {
    expect(formatAutomationSchedule('FREQ=YEARLY')).toBe('Invalid schedule')
  })

  it('formats hourly schedules using the stored minute', () => {
    expect(formatAutomationSchedule('FREQ=HOURLY;BYMINUTE=5')).toBe('Hourly at :05')
  })

  it('computes custom cron schedules', () => {
    const next = nextAutomationOccurrenceAfter(
      '15 10 * * 1-5',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(next).toBe(new Date('2026-05-18T10:15:00').getTime())

    const latest = latestAutomationOccurrenceAtOrBefore(
      '15 10 * * 1-5',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(latest).toBe(new Date('2026-05-15T10:15:00').getTime())
  })

  it('labels valid custom cron schedules without treating them as invalid', () => {
    expect(formatAutomationSchedule('*/30 9-17 * * MON-FRI')).toBe(
      'Custom cron: */30 9-17 * * MON-FRI'
    )
  })

  it('treats all-value cron day fields as unrestricted for DOM/DOW matching', () => {
    const next = nextAutomationOccurrenceAfter(
      '0 9 */1 * MON',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(next).toBe(new Date('2026-05-18T09:00:00').getTime())
    expect(isValidAutomationSchedule('0 9 * * 0-7')).toBe(true)
    expect(isValidAutomationSchedule('0 9 * * 1-7')).toBe(true)
  })

  it('rejects cron fields with malformed separators', () => {
    expect(isValidAutomationSchedule('*/15/2 9 * * *')).toBe(false)
    expect(isValidAutomationSchedule('0 9 1--5 * *')).toBe(false)
  })

  it('rejects syntactically valid cron schedules with no possible run', () => {
    expect(isValidAutomationSchedule('0 0 31 2 *')).toBe(false)
  })

  it('finds rare but valid leap-day custom cron schedules', () => {
    const next = nextAutomationOccurrenceAfter(
      '0 0 29 2 *',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(next).toBe(new Date('2028-02-29T00:00:00').getTime())
  })
})
