import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule } from './automation-schedules'
import {
  automationScheduleParseError,
  isValidAutomationSchedule,
  needsScheduleRulesCapability,
  parseAutomationRrule,
  parseSchedule,
  tryParseAutomationRrule
} from './automation-schedule-parsing'

describe('strict RRULE parsing', () => {
  it.each([
    ['FREQ=WEEKLY;WKST=MO;BYDAY=WE', 'Unsupported RRULE part "WKST" for FREQ=WEEKLY.'],
    ['FREQ=DAILY;COUNT=2', 'Unsupported RRULE part "COUNT" for FREQ=DAILY.'],
    ['FREQ=DAILY;UNTIL=20271231T000000Z', 'Unsupported RRULE part "UNTIL" for FREQ=DAILY.'],
    ['FREQ=WEEKLY;BYDAY=MO;BYDAY=TU', 'Unsupported RRULE part "BYDAY" for FREQ=WEEKLY.'],
    ['FREQ=WEEKLY;BYDAY=MO;BYMONTHDAY=-2', 'Unsupported RRULE part "BYMONTHDAY" for FREQ=WEEKLY.'],
    ['FREQ=HOURLY;BYHOUR=9;BYMINUTE=0', 'Unsupported RRULE part "BYHOUR" for FREQ=HOURLY.'],
    ['FREQ=DAILY;BYDAY=MO', 'Unsupported RRULE part "BYDAY" for FREQ=DAILY.'],
    ['FREQ=DAILY;BYHOUR', 'Unsupported RRULE part "BYHOUR" for FREQ=DAILY.']
  ])('refuses %s naming the part', (rule, message) => {
    expect(() => parseSchedule(rule)).toThrow(message)
    expect(isValidAutomationSchedule(rule)).toBe(false)
  })

  it.each([
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=53',
    'FREQ=DAILY;INTERVAL=2.5',
    'FREQ=DAILY;INTERVAL='
  ])('refuses interval %s', (rule) => expect(() => parseSchedule(rule)).toThrow(/interval/i))

  it.each(['FREQ=WEEKLY;BYDAY=5MO', 'FREQ=DAILY;BYHOUR=', 'FREQ=MONTHLY;BYMONTHDAY=15'])(
    'refuses %s',
    (rule) => expect(isValidAutomationSchedule(rule)).toBe(false)
  )

  // Every shape the app writes, plus EVENT_ONLY_SCHEDULE, still decodes to the same preset.
  it.each([
    ['FREQ=HOURLY;BYMINUTE=15', { preset: 'hourly', hour: 9, minute: 15, dayOfWeek: 1 }],
    ['FREQ=DAILY;BYHOUR=0;BYMINUTE=0', { preset: 'daily', hour: 0, minute: 0, dayOfWeek: 1 }],
    [
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30',
      { preset: 'weekdays', hour: 9, minute: 30, dayOfWeek: 1 }
    ],
    [
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=59',
      { preset: 'weekly', hour: 23, minute: 59, dayOfWeek: 0 }
    ],
    [
      'FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0;',
      { preset: 'daily', hour: 9, minute: 0, dayOfWeek: 1 }
    ],
    ['freq=DAILY;byhour=9', { preset: 'daily', hour: 9, minute: 0, dayOfWeek: 1 }]
  ])('still decodes %s', (rule, expected) => expect(parseAutomationRrule(rule)).toEqual(expected))

  it('describes an interval rule as custom, never as its plain preset', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'
    expect(isValidAutomationSchedule(rule)).toBe(true)
    expect(tryParseAutomationRrule(rule)).toBeNull()
    expect(describeAutomationSchedule(rule)).toEqual({ kind: 'custom', expression: rule })
    expect(needsScheduleRulesCapability(rule)).toBe(true)
    expect(needsScheduleRulesCapability('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE')).toBe(false)
    expect(needsScheduleRulesCapability('0 9 * * 1')).toBe(false)
  })

  it('escapes control bytes in the refused part it names', () => {
    expect(automationScheduleParseError('FREQ=DAILY;\u001b[2J\u0007=1')).toBe(
      'Unsupported RRULE part "\\x1b[2J\\x07" for FREQ=DAILY.'
    )
    expect(automationScheduleParseError('FREQ=DAILY;BYHOUR=9')).toBeNull()
  })
})
