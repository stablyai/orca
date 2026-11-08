import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule, formatAutomationSchedule } from './automation-schedules'
import {
  buildAutomationRrule,
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import {
  isValidAutomationSchedule,
  parseAutomationRrule,
  tryParseAutomationRrule
} from './automation-schedule-parsing'

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

  it.each([
    ['TU,TH,SA', new Date(2026, 9, 6, 8)],
    ['MO,WE,FR,SU', new Date(2026, 9, 7, 8)],
    ['MO,TU,WE,TH,FR,SA,SU', new Date(2026, 9, 6, 8)]
  ])(
    'labels a runnable multi-day weekly rule %s without calling it invalid (#24985)',
    (days, next) => {
      const rrule = `FREQ=WEEKLY;BYDAY=${days};BYHOUR=8;BYMINUTE=0`
      const start = new Date(2026, 9, 5, 9).getTime()

      expect(isValidAutomationSchedule(rrule)).toBe(true)
      expect(nextAutomationOccurrenceAfter(rrule, start, start)).toBe(next.getTime())
      expect(formatAutomationSchedule(`  ${rrule}  `)).toBe(rrule)
      expect(describeAutomationSchedule(`  ${rrule}  `)).toEqual({
        kind: 'custom',
        expression: rrule
      })
    }
  )

  it.each([
    ['\u001b[2J', '\\x1b[2J'],
    ['\u001b]52;c;ZXZpbA==\u0007', '\\x1b]52;c;ZXZpbA==\\x07'],
    ['\u009b2J', '\\x9b2J'],
    ['\t\r\n', '\\x09\\x0d\\x0a']
  ])('renders accepted control bytes as printable schedule text', (control, escaped) => {
    const prefix = 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=8;BYMINUTE=0;X='
    const expression = `${prefix}${control};Y=keep`
    const expected = `${prefix}${escaped};Y=keep`

    expect(isValidAutomationSchedule(expression)).toBe(true)
    expect(formatAutomationSchedule(expression)).toBe(expected)
    expect(describeAutomationSchedule(expression)).toEqual({ kind: 'custom', expression: expected })
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

  // Star-step */1 stays unrestricted, preserving AND and Monday-only firing (#15896).
  it('treats a stepped cron day-of-month field as unrestricted for DOM/DOW matching', () => {
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

  it('finds rare but valid leap-day custom cron schedules', () => {
    const next = nextAutomationOccurrenceAfter(
      '0 0 29 2 *',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(next).toBe(new Date('2028-02-29T00:00:00').getTime())
  })
})
