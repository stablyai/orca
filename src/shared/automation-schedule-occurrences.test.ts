import { afterAll, describe, expect, it } from 'vitest'
import { floorToMinute } from './automation-cron-occurrence'
import { nextAutomationOccurrenceAfter } from './automation-schedule-occurrences'

// Why: Node on Windows ignores runtime TZ changes; skip there instead of failing opaquely.
const originalTz = process.env.TZ
process.env.TZ = 'America/New_York'

/** Whether the TZ override above actually took effect for this process. */
function newYorkTzApplied(): boolean {
  return new Date('2026-11-01T01:30:00-04:00').getTimezoneOffset() === 240
}

/** Restore the process timezone exactly as it started (unset stays unset). */
function restoreOriginalTimezone(): void {
  if (originalTz === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = originalTz
  }
}

afterAll(restoreOriginalTimezone)

describe.skipIf(!newYorkTzApplied())('automation schedule occurrences across DST', () => {
  const dtstart = new Date('2026-10-31T12:00:00-04:00').getTime()
  const firstHalfOfRepeatedHour = new Date('2026-11-01T01:30:00-04:00').getTime()
  const secondHalfOfRepeatedHour = new Date('2026-11-01T01:30:00-05:00').getTime()
  const nextDay = new Date('2026-11-02T01:30:00-05:00').getTime()

  it('floors a fall-back ambiguous minute without moving backwards in absolute time', () => {
    const duringSecondRepeatedMinute = secondHalfOfRepeatedHour + 45_000
    expect(floorToMinute(duringSecondRepeatedMinute)).toBe(secondHalfOfRepeatedHour)
  })

  it('fires both repeats of a cron minute in the DST fall-back hour', () => {
    const expression = '30 1 * * *'
    expect(nextAutomationOccurrenceAfter(expression, dtstart, dtstart)).toBe(
      firstHalfOfRepeatedHour
    )
    expect(nextAutomationOccurrenceAfter(expression, dtstart, firstHalfOfRepeatedHour)).toBe(
      secondHalfOfRepeatedHour
    )
  })

  it('advances past the repeated hour instead of returning the after instant', () => {
    const expression = '30 1 * * *'
    const next = nextAutomationOccurrenceAfter(expression, dtstart, secondHalfOfRepeatedHour)
    expect(next).toBe(nextDay)
  })

  it('returns strictly-later instants for every after value inside the repeated hour', () => {
    const expression = '30 1 * * *'
    for (let after = secondHalfOfRepeatedHour; after < secondHalfOfRepeatedHour + 3_600_000; after += 60_000) {
      const next = nextAutomationOccurrenceAfter(expression, dtstart, after)
      expect(next).toBeGreaterThan(after)
    }
  })

  it('still skips the nonexistent spring-forward minute', () => {
    const springStart = new Date('2026-03-07T12:00:00-05:00').getTime()
    const next = nextAutomationOccurrenceAfter('30 2 * * *', springStart, springStart)
    expect(next).toBe(new Date('2026-03-09T02:30:00-04:00').getTime())
  })
})
