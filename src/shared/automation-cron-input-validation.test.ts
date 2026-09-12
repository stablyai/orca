import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextAutomationOccurrenceAfter } from './automation-schedule-occurrences'
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

  // The gate is input-only. A row persisted before it keeps running the cadence it was saved
  // with rather than throwing mid-tick, which is what keeps it editable (see the editor tests).
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

describe('cron occurrence local-time controls', () => {
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

    // Pre-existing limit this change does not touch or fix (#20154): local 01:30 is ambiguous,
    // so flooring it rebuilds the earlier EDT instant and the scan lands back on the EST repeat
    // instead of tomorrow. Pinned so a later DST fix has to update it deliberately.
    expect(
      nextAutomationOccurrenceAfter('30 1 * * *', new Date(2026, 0, 1).getTime(), second)
    ).toBe(second)
  })
})
