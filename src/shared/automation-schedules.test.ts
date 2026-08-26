import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_CRON_EXPRESSION_MAX_BYTES,
  buildAutomationCronSchedule,
  buildAutomationRrule,
  classifyAutomationCronSchedule,
  describeAutomationSchedule,
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

const CRON_ANCHOR = new Date('2026-05-01T00:00:00').getTime()

function collectCronMinutes(cron: string, count: number): number[] {
  const minutes: number[] = []
  let cursor = CRON_ANCHOR
  for (let index = 0; index < count; index += 1) {
    cursor = nextAutomationOccurrenceAfter(cron, CRON_ANCHOR, cursor)
    minutes.push(new Date(cursor).getMinutes())
  }
  return minutes
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

  // Why: shared labels feed the CLI, so they must stay English on any OS locale (#14404).
  it('formats schedule labels without reading the OS weekday names', () => {
    const nativeDateTimeFormat = Intl.DateTimeFormat
    const dateTimeFormat = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      return new nativeDateTimeFormat(...args)
    } as unknown as typeof Intl.DateTimeFormat)
    const weeklyRrule = buildAutomationRrule({ preset: 'weekly', hour: 9, minute: 0, dayOfWeek: 5 })

    expect(formatAutomationSchedule('30 12 * * 7')).toBe(`Sundays at ${formatTimeForTest(12, 30)}`)
    expect(formatAutomationSchedule(weeklyRrule)).toBe(`Fridays at ${formatTimeForTest(9, 0)}`)
    expect(classifyAutomationCronSchedule('30 12 * * 7').label).toBe(
      `Sundays at ${formatTimeForTest(12, 30)}`
    )
    expect(
      dateTimeFormat.mock.calls.filter(([, options]) => options?.weekday !== undefined)
    ).toHaveLength(0)
  })

  it('exposes a locale-free descriptor for callers that render their own copy', () => {
    expect(describeAutomationSchedule('30 12 * * 7')).toEqual({
      kind: 'weekly',
      hour: 12,
      minute: 30,
      dayOfWeek: 0
    })
    expect(describeAutomationSchedule('5 * * * *')).toEqual({ kind: 'hourly', minute: 5 })
    expect(describeAutomationSchedule('15 10 * * MON-FRI')).toEqual({
      kind: 'weekdays',
      hour: 10,
      minute: 15
    })
    expect(describeAutomationSchedule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 0
    })
    expect(describeAutomationSchedule('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0')).toEqual({
      kind: 'weekly',
      hour: 9,
      minute: 0,
      dayOfWeek: 5
    })
    expect(describeAutomationSchedule('*/30 9-17 * * MON-FRI')).toEqual({ kind: 'custom' })
    expect(describeAutomationSchedule('FREQ=YEARLY')).toEqual({ kind: 'invalid' })
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

  it('runs a bare start value with a step through the end of its field', () => {
    // Why: `5/15` means 5,20,35,50; dropping the step made the automation hourly.
    expect(collectCronMinutes('5/15 * * * *', 4)).toEqual([5, 20, 35, 50])
    // A bare value with no step still means exactly that value, once per hour.
    expect(collectCronMinutes('5 * * * *', 2)).toEqual([5, 5])
    // `1/2` in day-of-week is Mon/Wed/Fri/Sun, matching `1-7/2`.
    expect(isValidAutomationSchedule('0 9 * * 1/2')).toBe(true)
    expect(nextAutomationOccurrenceAfter('0 9 * * 1/2', CRON_ANCHOR, CRON_ANCHOR)).toBe(
      nextAutomationOccurrenceAfter('0 9 * * 1-7/2', CRON_ANCHOR, CRON_ANCHOR)
    )
  })

  it('classifies a stepped bare start as custom rather than hourly', () => {
    // Why: with the step dropped, `5/15` collapsed to one minute and read as "Hourly at :05".
    expect(classifyAutomationCronSchedule('5/15 * * * *').kind).toBe('custom')
    expect(formatAutomationSchedule('5/15 * * * *')).toBe('Custom schedule')
    expect(classifyAutomationCronSchedule('5 * * * *').kind).toBe('hourly')
  })

  it('treats a stepped bare start that spans every day as unrestricted', () => {
    // Why: day restriction keys off set size, so `0/1` must widen to all seven days like `*`.
    // Anchored past the 1st so a restricted day-of-week would switch match to OR and fire sooner.
    const afterFirst = new Date('2026-05-01T10:00:00').getTime()
    expect(nextAutomationOccurrenceAfter('0 9 1 * 0/1', CRON_ANCHOR, afterFirst)).toBe(
      nextAutomationOccurrenceAfter('0 9 1 * *', CRON_ANCHOR, afterFirst)
    )
    expect(nextAutomationOccurrenceAfter('0 9 1 * 0/1', CRON_ANCHOR, afterFirst)).not.toBe(
      nextAutomationOccurrenceAfter('0 9 1 * 0', CRON_ANCHOR, afterFirst)
    )
    // Known divergence (#15896): vixie restricts off a literal `*`, so it ORs `1/1` with Mondays
    // and fires Wed Jul 1 as well. Pinned so the follow-up has to flip it on purpose.
    const beforeJulyFirst = new Date('2026-06-30T10:00:00').getTime()
    expect(nextAutomationOccurrenceAfter('0 0 1/1 * 1', CRON_ANCHOR, beforeJulyFirst)).toBe(
      nextAutomationOccurrenceAfter('0 0 * * 1', CRON_ANCHOR, beforeJulyFirst)
    )
    expect(nextAutomationOccurrenceAfter('0 0 1/1 * 1', CRON_ANCHOR, beforeJulyFirst)).not.toBe(
      nextAutomationOccurrenceAfter('0 0 1 * 1', CRON_ANCHOR, beforeJulyFirst)
    )
  })

  it('keeps wildcard and range steps intact and applies steps per list element', () => {
    expect(collectCronMinutes('*/15 * * * *', 4)).toEqual([15, 30, 45, 0])
    expect(collectCronMinutes('5-30/10 * * * *', 3)).toEqual([5, 15, 25])
    expect(collectCronMinutes('0,5/20 * * * *', 4)).toEqual([5, 25, 45, 0])
  })

  it('still rejects malformed steps instead of silently dropping them', () => {
    expect(isValidAutomationSchedule('5/0 * * * *')).toBe(false)
    expect(isValidAutomationSchedule('5/-1 * * * *')).toBe(false)
    expect(isValidAutomationSchedule('5/abc * * * *')).toBe(false)
    expect(isValidAutomationSchedule('5/ * * * *')).toBe(false)
    expect(isValidAutomationSchedule('60/15 * * * *')).toBe(false)
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
