import { describe, expect, it } from 'vitest'
import { describeAutomationSchedule, formatAutomationSchedule } from './automation-schedules'
import {
  latestAutomationOccurrenceAtOrBefore,
  needsScheduleRulesCapability,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import {
  getAutomationScheduleInputError,
  isRunnableAutomationSchedule,
  isValidAutomationSchedule,
  tryParseAutomationRrule,
  withoutIgnoredRruleParts
} from './automation-schedule-parsing'

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

    expect(isRunnableAutomationSchedule(expression)).toBe(true)
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

// New input refuses RRULE parts the scheduler would drop; stored rules keep running with their cadence label (#45519).
// INTERVAL runs every Nth period, so it is no longer dropped.
describe('RRULE parts the scheduler drops', () => {
  const everyOtherWednesday = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'

  it.each([
    ['FREQ=DAILY;INTERVAL=53', 'INTERVAL=53'],
    ['FREQ=DAILY;INTERVAL=2.5', 'INTERVAL=2.5'],
    ['FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=WE', 'WKST=SU'],
    ['FREQ=DAILY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', 'BYDAY=MO'],
    ['FREQ=HOURLY;BYHOUR=9;BYMINUTE=0', 'BYHOUR=9'],
    ['FREQ=WEEKLY;BYDAY=MO;BYDAY=WE;BYHOUR=9', 'BYDAY=MO'],
    ['FREQ=DAILY;BYMINUTE=', 'BYMINUTE='],
    ['FREQ=DAILY;BYHOUR=9=10', 'BYHOUR=9=10']
  ])('refuses %s as new input, naming %s', (rule, part) => {
    expect(isValidAutomationSchedule(rule)).toBe(false)
    expect(getAutomationScheduleInputError(rule)).toContain(`"${part}"`)
  })

  it.each([
    everyOtherWednesday,
    'FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=WE',
    'FREQ=DAILY;INTERVAL=3;WKST=SU',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;',
    'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0'
  ])('accepts %s', (rule) => {
    expect(getAutomationScheduleInputError(rule)).toBeNull()
  })

  // A move re-creates the automation on another host, whose create check refuses dropped parts.
  it.each([
    [`${everyOtherWednesday};COUNT=3`, everyOtherWednesday],
    ['FREQ=WEEKLY;BYDAY=MO;BYDAY=WE;BYHOUR=9;COUNT=3', 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0'],
    ['FREQ=DAILY;BYDAY=MO;BYHOUR=9=10;UNTIL=20270101T000000Z', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'],
    ['FREQ=HOURLY;BYHOUR=9;BYMINUTE=15;INTERVAL=3', 'FREQ=HOURLY;INTERVAL=3;BYMINUTE=15']
  ])('rebuilds stored %s for a move with the same runs', (stored, rebuilt) => {
    expect(withoutIgnoredRruleParts(stored)).toBe(rebuilt)
    expect(getAutomationScheduleInputError(rebuilt)).toBeNull()
    const dtstart = new Date('2026-05-15T00:00:00').getTime()
    let storedRun = dtstart
    let rebuiltRun = dtstart
    for (let i = 0; i < 5; i += 1) {
      storedRun = nextAutomationOccurrenceAfter(stored, dtstart, storedRun)
      rebuiltRun = nextAutomationOccurrenceAfter(rebuilt, dtstart, rebuiltRun)
      expect(rebuiltRun).toBe(storedRun)
    }
  })

  it.each([
    'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    everyOtherWednesday,
    '0 9 * * 1-5',
    'not a rule'
  ])('keeps %s for a move when nothing is dropped', (stored) => {
    expect(withoutIgnoredRruleParts(stored)).toBe(stored)
  })

  it('gives an interval rule no preset, and only it needs the host capability', () => {
    expect(tryParseAutomationRrule(everyOtherWednesday)).toBeNull()
    expect(describeAutomationSchedule(everyOtherWednesday)).toEqual({
      kind: 'custom',
      expression: everyOtherWednesday
    })
    expect(needsScheduleRulesCapability(everyOtherWednesday)).toBe(true)
    expect(needsScheduleRulesCapability('FREQ=WEEKLY;INTERVAL=1;BYDAY=WE')).toBe(false)
    expect(needsScheduleRulesCapability('0 9 * * 1')).toBe(false)
  })
})

describe('schedule refusal text', () => {
  const accepted =
    'Use hourly, a 5-field cron expression such as "*/10 * * * *" (every 10 minutes), or an RRULE of FREQ=HOURLY with BYMINUTE, FREQ=DAILY with BYHOUR and BYMINUTE, or FREQ=WEEKLY with BYDAY, BYHOUR and BYMINUTE, each with an optional INTERVAL of 1 to 52.'
  const hints = { extraForms: 'hourly', oneTimeRun: 'For a single run, use --once.' }
  const limits = 'Schedules repeat until removed, so DTSTART, UNTIL and COUNT are not supported.'

  it.each([
    ['not a rule', `Bad. ${accepted}`],
    ['RRULE:FREQ=DAILY', `Bad. Drop the "RRULE:" prefix. ${accepted}`],
    [
      'DTSTART:20261121T090000Z\nRRULE:FREQ=DAILY',
      `Bad. Drop the "RRULE:" prefix. ${limits} For a single run, use --once. ${accepted}`
    ],
    [
      'FREQ=DAILY;COUNT=1',
      `Bad. RRULE part "COUNT=1" is not supported. ${limits} For a single run, use --once. ${accepted}`
    ],
    ['FREQ=DAILY;INTERVAL=0', `Bad. RRULE part "INTERVAL=0" is not supported. ${accepted}`]
  ])('refuses %j naming what is accepted', (schedule, message) => {
    expect(getAutomationScheduleInputError(schedule, 'Bad.', hints)).toBe(message)
  })

  it('accepts the cron interval example it gives', () => {
    expect(getAutomationScheduleInputError('*/10 * * * *')).toBeNull()
  })
})
