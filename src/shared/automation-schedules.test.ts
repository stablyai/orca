import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_CRON_EXPRESSION_MAX_BYTES,
  buildAutomationCronSchedule,
  buildAutomationRrule,
  classifyAutomationCronSchedule,
  formatAutomationSchedule,
  getAutomationCronExpressionFields,
  isValidAutomationCronSchedule,
  isValidAutomationSchedule,
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter,
  parseAutomationRrule,
  tryParseAutomationRrule
} from './automation-schedules'

function formatTimeForTest(hour: number, minute: number): string {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('does not return a future hourly dtstart that is off the scheduled minute', () => {
    const rrule = buildAutomationRrule({ preset: 'hourly', hour: 9, minute: 0 })
    const next = nextAutomationOccurrenceAfter(
      rrule,
      new Date('2026-05-13T10:30:00').getTime(),
      new Date('2026-05-13T09:00:00').getTime()
    )
    expect(next).toBe(new Date('2026-05-13T11:00:00').getTime())
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

  it('rejects weekly RRULE schedules that cannot match any day', () => {
    const rrule = 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0'

    expect(isValidAutomationSchedule(rrule)).toBe(false)
    expect(() =>
      nextAutomationOccurrenceAfter(
        rrule,
        new Date('2026-05-01T00:00:00').getTime(),
        new Date('2026-05-02T00:00:00').getTime()
      )
    ).toThrow('Invalid recurrence day.')
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

  it('builds cron schedules from simple automation presets', () => {
    expect(buildAutomationCronSchedule({ preset: 'hourly', hour: 9, minute: 15 })).toBe(
      '15 * * * *'
    )
    expect(buildAutomationCronSchedule({ preset: 'daily', hour: 9, minute: 15 })).toBe('15 9 * * *')
    expect(buildAutomationCronSchedule({ preset: 'weekdays', hour: 9, minute: 15 })).toBe(
      '15 9 * * 1-5'
    )
    expect(
      buildAutomationCronSchedule({ preset: 'weekly', hour: 9, minute: 15, dayOfWeek: 0 })
    ).toBe('15 9 * * 0')
  })

  it('formats simple cron schedules with friendly labels', () => {
    expect(formatAutomationSchedule('5 * * * *')).toBe('Hourly at :05')
    expect(formatAutomationSchedule('15 10 * * *')).toBe(`Daily at ${formatTimeForTest(10, 15)}`)
    expect(formatAutomationSchedule('15 10 * * MON-FRI')).toBe(
      `Weekdays at ${formatTimeForTest(10, 15)}`
    )
    expect(formatAutomationSchedule('30 12 * * 7')).toBe(`Sundays at ${formatTimeForTest(12, 30)}`)
  })

  it('tokenizes pasted cron whitespace without regex field splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const schedule = ['15', String.fromCharCode(160), '10\n*\t*\rMON-FRI'].join('')

    expect(getAutomationCronExpressionFields(schedule)).toEqual(['15', '10', '*', '*', 'MON-FRI'])
    expect(formatAutomationSchedule(schedule)).toBe(`Weekdays at ${formatTimeForTest(10, 15)}`)
    expect(
      split.mock.calls.filter(([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+')
    ).toHaveLength(0)
  })

  it('rejects oversized pasted cron expressions before field tokenization', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const oversizedSchedule = 'secret-cron-field '.repeat(AUTOMATION_CRON_EXPRESSION_MAX_BYTES)

    expect(getAutomationCronExpressionFields(oversizedSchedule)).toEqual([])
    expect(isValidAutomationCronSchedule(oversizedSchedule)).toBe(false)
    expect(
      split.mock.calls.filter(([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+')
    ).toHaveLength(0)
  })

  it('classifies simple cron schedules for provider edit flows', () => {
    expect(classifyAutomationCronSchedule('15 10 * * MON-FRI')).toMatchObject({
      kind: 'weekdays',
      hour: 10,
      minute: 15
    })
    expect(classifyAutomationCronSchedule('30 12 * * 7')).toMatchObject({
      kind: 'weekly',
      hour: 12,
      minute: 30,
      dayOfWeek: 0
    })
  })

  it('labels valid unsupported cron schedules as custom schedules', () => {
    expect(formatAutomationSchedule('*/30 9-17 * * MON-FRI')).toBe('Custom schedule')
    expect(formatAutomationSchedule('0 9 1 * *')).toBe('Custom schedule')
    expect(formatAutomationSchedule('0 9 1 * MON')).toBe('Custom schedule')
    expect(formatAutomationSchedule('0 9,17 * * MON-FRI')).toBe('Custom schedule')
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
    expect(formatAutomationSchedule('0 0 31 2 *')).toBe('Invalid schedule')
  })

  it('rejects RRULE input with the cron-only validator', () => {
    const rrule = buildAutomationRrule({ preset: 'daily', hour: 9, minute: 0 })
    expect(isValidAutomationSchedule(rrule)).toBe(true)
    expect(isValidAutomationCronSchedule(rrule)).toBe(false)
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
