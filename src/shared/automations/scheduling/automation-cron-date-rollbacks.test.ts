import { expect, it } from 'vitest'
import { automationScheduleCalendar } from './automation-schedule-calendar'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

it('preserves matching minutes when a midnight rollback revisits the previous date', () => {
  const timezone = 'America/St_Johns'
  const calendar = automationScheduleCalendar(timezone)
  const dtstart = Date.parse('2009-10-31T00:00:00Z')
  const firstMidnight = Date.parse('2009-11-01T02:30:00Z')
  const minutes = Array.from({ length: 60 }, (_, minute) => firstMidnight + minute * 60_000)
  const saturday = minutes.find((minute) => {
    const wall = calendar.fields(minute)
    return wall.weekday === 6 && wall.hour === 23
  })
  const sunday = minutes.findLast((minute) => {
    const wall = calendar.fields(minute)
    return wall.weekday === 0 && wall.hour === 0
  })

  expect(saturday).toBeDefined()
  expect(sunday).toBeDefined()
  expect(
    nextAutomationOccurrenceAfter('* 23 * * 6', dtstart, firstMidnight - 60_000, timezone)
  ).toBe(saturday)
  expect(
    latestAutomationOccurrenceAtOrBefore(
      '* 0 * * 0',
      dtstart,
      firstMidnight + 59 * 60_000,
      timezone
    )
  ).toBe(sunday)
})
