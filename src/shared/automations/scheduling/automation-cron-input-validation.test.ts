import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import { isRunnableAutomationSchedule, parseCronExpression } from './automation-schedule-parsing'

const ascending = (values: Set<number>): number[] => [...values].sort((left, right) => left - right)
const DTSTART = Date.parse('2027-01-01T00:00:00Z')

function runsBetween(schedule: string, from: string, to: string, timezone?: string): string[] {
  const runs: string[] = []
  let after = Date.parse(from)
  for (;;) {
    after = nextAutomationOccurrenceAfter(schedule, DTSTART, after, timezone)
    if (after > Date.parse(to)) {
      return runs
    }
    runs.push(new Date(after).toISOString())
  }
}

describe('cron oversized steps (#15895)', () => {
  // Input-only validation preserves legacy cadence without mid-tick errors, keeping stored schedules editable.
  it('still runs a persisted oversized step, degenerating it to its single value', () => {
    expect(isRunnableAutomationSchedule('*/90 * * * *')).toBe(true)
    expect(ascending(parseCronExpression('*/90 * * * *').minutes)).toEqual([0])
    expect(
      nextAutomationOccurrenceAfter(
        '*/90 * * * *',
        new Date(2026, 4, 1, 0, 0).getTime(),
        new Date(2026, 4, 15, 9, 5).getTime()
      )
    ).toBe(new Date(2026, 4, 15, 10, 0).getTime())
  })
})

// Windows Node uses OS timezone and ignores runtime TZ changes, so skip this stub/precondition there.
describe.skipIf(process.platform === 'win32')('cron occurrence local-time controls', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('fires a fixed time local spring-forward skips once, the gap length later', () => {
    vi.stubEnv('TZ', 'America/New_York')
    // Precondition: the stub took and 2027-03-14 really does lose an hour here.
    expect(new Date(2027, 2, 14, 12).getTimezoneOffset()).toBe(
      new Date(2027, 2, 14, 0).getTimezoneOffset() - 60
    )

    expect(
      runsBetween('30 2 * * *', '2027-03-13T12:00:00-05:00', '2027-03-15T12:00:00-04:00')
    ).toEqual(['2027-03-14T07:30:00.000Z', '2027-03-15T06:30:00.000Z'])
  })

  it('fires a fixed time local fall-back repeats once, on its first pass', () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(new Date(2027, 10, 7, 12).getTimezoneOffset()).toBe(
      new Date(2027, 10, 7, 0).getTimezoneOffset() + 60
    )

    expect(
      runsBetween('30 1 * * *', '2027-11-06T12:00:00-04:00', '2027-11-08T12:00:00-05:00')
    ).toEqual(['2027-11-07T05:30:00.000Z', '2027-11-08T06:30:00.000Z'])
    const secondPass = Date.parse('2027-11-07T01:45:00-05:00')
    expect(latestAutomationOccurrenceAtOrBefore('30 1 * * *', DTSTART, secondPass)).toBe(
      Date.parse('2027-11-07T01:30:00-04:00')
    )
  })

  it('advances hourly schedules through both passes of the fall-back hour', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const dtstart = new Date(2026, 0, 1).getTime()
    const firstPass = new Date('2026-11-01T01:30:00-04:00').getTime()
    const secondPass = new Date('2026-11-01T01:30:00-05:00').getTime()

    expect(nextAutomationOccurrenceAfter('FREQ=HOURLY;BYMINUTE=30', dtstart, firstPass)).toBe(
      secondPass
    )
    expect(nextAutomationOccurrenceAfter('FREQ=HOURLY;BYMINUTE=30', dtstart, secondPass)).toBe(
      secondPass + 60 * 60 * 1000
    )
    expect(
      latestAutomationOccurrenceAtOrBefore('FREQ=HOURLY;BYMINUTE=30', dtstart, secondPass + 5_000)
    ).toBe(secondPass)
    // An hour wildcard counts elapsed hours, so cron's hourly keeps both passes too.
    expect(nextAutomationOccurrenceAfter('30 * * * *', dtstart, firstPass)).toBe(secondPass)
  })
})

// The automation's own zone takes the Intl path, which runs on every platform.
describe('cron fixed times across DST in a named zone', () => {
  const zone = 'America/New_York'

  it('fires a skipped time once and a repeated time once, as the RRULE preset does', () => {
    const springForward = ['2027-03-13T12:00:00-05:00', '2027-03-15T12:00:00-04:00'] as const
    const fallBack = ['2027-11-06T12:00:00-04:00', '2027-11-08T12:00:00-05:00'] as const

    expect(runsBetween('30 2 * * *', ...springForward, zone)).toEqual([
      '2027-03-14T07:30:00.000Z',
      '2027-03-15T06:30:00.000Z'
    ])
    expect(runsBetween('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', ...springForward, zone)).toEqual(
      runsBetween('30 2 * * *', ...springForward, zone)
    )
    expect(runsBetween('30 1 * * *', ...fallBack, zone)).toEqual([
      '2027-11-07T05:30:00.000Z',
      '2027-11-08T06:30:00.000Z'
    ])
    expect(runsBetween('FREQ=DAILY;BYHOUR=1;BYMINUTE=30', ...fallBack, zone)).toEqual(
      runsBetween('30 1 * * *', ...fallBack, zone)
    )
  })
})
