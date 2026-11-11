import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule, formatAutomationSchedule } from './automation-schedules'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import { isValidAutomationSchedule } from './automation-schedule-parsing'

describe('automation schedules', () => {
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

  it('finds rare but valid leap-day custom cron schedules', () => {
    const next = nextAutomationOccurrenceAfter(
      '0 0 29 2 *',
      new Date('2026-05-01T00:00:00').getTime(),
      new Date('2026-05-15T12:00:00').getTime()
    )
    expect(next).toBe(new Date('2028-02-29T00:00:00').getTime())
  })
})
