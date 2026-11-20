import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule, formatAutomationSchedule } from './automation-schedules'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import { isValidAutomationSchedule } from './automation-schedule-parsing'

describe('automation schedules', () => {
  it.each(['\u001b[2J', '\u001b]52;c;ZXZpbA==\u0007', '\u009b2J', '\t\r\n'])(
    'never renders control bytes from a refused rule',
    (control) => {
      const expression = `FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=8;BYMINUTE=0;X=${control};Y=keep`

      expect(isValidAutomationSchedule(expression)).toBe(false)
      expect(formatAutomationSchedule(expression)).toBe('Invalid schedule')
      expect(describeAutomationSchedule(expression)).toEqual({ kind: 'invalid' })
    }
  )

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
