import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'
import {
  isValidAutomationCronSchedule,
  isValidAutomationSchedule,
  isRunnableAutomationSchedule,
  parseCronExpression
} from './automation-schedule-parsing'

const ascending = (values: Set<number>): number[] => [...values].sort((left, right) => left - right)

describe('cron oversized steps (#15895)', () => {
  it('refuses a step wider than the field domain at input time', () => {
    expect(isValidAutomationSchedule('*/90 * * * *')).toBe(false)
    expect(isValidAutomationCronSchedule('*/90 * * * *')).toBe(false)
    expect(isValidAutomationSchedule('0 */25 * * *')).toBe(false)
    expect(isValidAutomationSchedule('0 9 */32 * *')).toBe(false)
    expect(isValidAutomationSchedule('0 9 * */13 *')).toBe(false)
    // Day of week spans 0-7 but holds seven days, so 8 is oversized even though 8 <= 7-0+1.
    expect(isValidAutomationSchedule('0 9 * * */8')).toBe(false)
    expect(() => parseCronExpression('*/90 * * * *', { rejectOversizedStep: true })).toThrow(
      'Cron minute step must be between 1 and 60.'
    )
  })

  it('keeps every step that fits its field domain', () => {
    expect(isValidAutomationSchedule('*/15 * * * *')).toBe(true)
    expect(isValidAutomationSchedule('*/60 * * * *')).toBe(true)
    expect(isValidAutomationSchedule('0 */24 * * *')).toBe(true)
    expect(isValidAutomationSchedule('0 9 */31 * *')).toBe(true)
    expect(isValidAutomationSchedule('0 9 * */12 *')).toBe(true)
    expect(isValidAutomationSchedule('0 9 * * */7')).toBe(true)
  })

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

  it('skips the wall-clock hour that local spring-forward removes', () => {
    vi.stubEnv('TZ', 'America/New_York')
    // Precondition: the stub took and 2026-03-08 really does lose an hour here.
    expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).toBe(
      new Date(2026, 2, 8, 0).getTimezoneOffset() - 60
    )

    expect(
      nextAutomationOccurrenceAfter(
        '30 2 * * *',
        new Date(2026, 0, 1).getTime(),
        new Date(2026, 2, 8, 0, 0).getTime()
      )
    ).toBe(new Date(2026, 2, 9, 2, 30).getTime())
  })

  it('fires both repeats of the wall-clock hour local fall-back replays', () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(new Date(2026, 10, 1, 12).getTimezoneOffset()).toBe(
      new Date(2026, 10, 1, 0).getTimezoneOffset() + 60
    )

    const first = nextAutomationOccurrenceAfter(
      '30 1 * * *',
      new Date(2026, 0, 1).getTime(),
      new Date(2026, 10, 1, 0, 0).getTime()
    )
    const second = nextAutomationOccurrenceAfter(
      '30 1 * * *',
      new Date(2026, 0, 1).getTime(),
      first
    )

    expect(new Date(first).getHours()).toBe(1)
    expect(new Date(second).getHours()).toBe(1)
    expect(second - first).toBe(60 * 60 * 1000)

    expect(
      nextAutomationOccurrenceAfter('30 1 * * *', new Date(2026, 0, 1).getTime(), second + 5_000)
    ).toBe(new Date(2026, 10, 2, 1, 30).getTime())
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
  })
})
