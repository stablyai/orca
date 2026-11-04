import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  automationOnceDateInput,
  automationOnceRunAt,
  buildAutomationOnceSchedule,
  parseAutomationOnceSchedule
} from './automation-once-schedule'
import {
  isRunnableAutomationSchedule,
  isValidAutomationSchedule
} from './automation-schedule-parsing'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import { describeAutomationSchedule } from './automation-schedules'

afterEach(() => vi.useRealTimers())

describe('one-time automation schedules', () => {
  const runAt = Date.parse('2028-02-29T15:42:00.000Z')
  const schedule = 'ONCE=2028-02-29T15:42:00.000Z'

  it('round-trips the full date and time as an absolute instant', () => {
    expect(buildAutomationOnceSchedule(runAt)).toBe(schedule)
    expect(parseAutomationOnceSchedule(schedule)).toEqual({ kind: 'once', runAt })
    expect(describeAutomationSchedule(schedule)).toEqual({ kind: 'once', runAt })
  })

  it('converts the editor date and 24-hour time using the device time zone', () => {
    const timestamp = automationOnceRunAt('2028-02-29', '23:42')
    expect(timestamp).toBe(new Date(2028, 1, 29, 23, 42).getTime())
    expect(automationOnceDateInput(timestamp!)).toBe('2028-02-29')
  })

  it.each([
    ['2027-02-29', '09:00'],
    ['2028-04-31', '09:00'],
    ['2028-02-29', '24:00'],
    ['2028-02-29', '09:60'],
    ['', '09:00']
  ])('refuses an invalid date or time: %s %s', (date, time) => {
    expect(automationOnceRunAt(date, time)).toBeNull()
  })

  it.each([
    'ONCE=2027-02-29T15:42:00.000Z',
    'ONCE=2028-02-29T15:42:01.000Z',
    'ONCE=2028-02-29T15:42:00',
    'ONCE=not-a-date'
  ])('rejects malformed or ambiguous persisted instants: %s', (value) => {
    expect(() => parseAutomationOnceSchedule(value)).toThrow()
    expect(isRunnableAutomationSchedule(value)).toBe(false)
  })

  it('has one occurrence and never rolls forward to another year', () => {
    expect(nextAutomationOccurrenceAfter(schedule, runAt - 60_000, runAt - 1)).toBe(runAt)
    expect(latestAutomationOccurrenceAtOrBefore(schedule, runAt - 60_000, runAt - 1)).toBeNull()
    expect(latestAutomationOccurrenceAtOrBefore(schedule, runAt - 60_000, runAt)).toBe(runAt)
    expect(
      latestAutomationOccurrenceAtOrBefore(schedule, runAt - 60_000, runAt + 366 * 86400_000)
    ).toBe(runAt)
    expect(() => nextAutomationOccurrenceAfter(schedule, runAt - 60_000, runAt)).toThrow()
  })

  it('rejects past dates as new input while keeping saved schedules readable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(runAt - 1)
    expect(isValidAutomationSchedule(schedule)).toBe(true)
    vi.setSystemTime(runAt)
    expect(isValidAutomationSchedule(schedule)).toBe(false)
    expect(isRunnableAutomationSchedule(schedule)).toBe(true)
  })
})
