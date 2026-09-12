import { describe, expect, it } from 'vitest'
import { isValidAutomationSchedule, parseSchedule } from './automation-schedule-parsing'
import {
  buildAutomationRrule,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

describe('supported automation RRULE subset', () => {
  it.each([
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
    'FREQ=DAILY;COUNT=1',
    'FREQ=DAILY;UNTIL=20260906T090000Z',
    'FREQ=DAILY;BYMONTH=9',
    'FREQ=WEEKLY;BYDAY=MO;WKST=SU',
    'FREQ=DAILY;BYSECOND=30',
    'FREQ=DAILY;BYDAY=MO',
    'FREQ=HOURLY;BYHOUR=9',
    'FREQ=HOURLY;BYDAY=MO',
    'FREQ=DAILY;FREQ=HOURLY',
    'FREQ=DAILY;BYHOUR=9;byhour=10',
    'FREQ=DAILY;BYMINUTE=',
    'FREQ=DAILY;BYHOUR=9=10',
    'FREQ=DAILY;garbage',
    'FREQ=DAILY;',
    'FREQ=DAILY;BYHOUR= ',
    'FREQ=DAILY;BYMINUTE=0x10',
    'FREQ=WEEKLY;BYDAY=MO,,TU'
  ])('rejects unsupported or malformed recurrence: %s', (rrule) => {
    expect(isValidAutomationSchedule(rrule)).toBe(false)
    expect(() => parseSchedule(rrule)).toThrow()
    expect(() => nextAutomationOccurrenceAfter(rrule, 0, Date.now())).toThrow()
  })

  it.each(['hourly', 'daily', 'weekdays', 'weekly'] as const)(
    'accepts generated %s schedules',
    (preset) => {
      expect(isValidAutomationSchedule(buildAutomationRrule({ preset, hour: 9, minute: 15 }))).toBe(
        true
      )
    }
  )

  it('keeps multi-day weekly rules and optional time defaults', () => {
    expect(parseSchedule('FREQ=WEEKLY;BYDAY=MO,WE')).toMatchObject({
      freq: 'WEEKLY',
      byDay: ['MO', 'WE'],
      byHour: 9,
      byMinute: 0
    })
    expect(isValidAutomationSchedule('FREQ=DAILY')).toBe(true)
    expect(isValidAutomationSchedule('15 9 * * 1-5')).toBe(true)
  })
})
