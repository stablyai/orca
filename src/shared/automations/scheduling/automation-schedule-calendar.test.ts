import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextAutomationOccurrenceAfter } from './automation-schedule-occurrences'

afterEach(() => vi.unstubAllEnvs())

function nextRuns(rrule: string, timezone: string, from: string, count: number): string[] {
  const runs: string[] = []
  let after = Date.parse(from)
  for (let index = 0; index < count; index += 1) {
    after = nextAutomationOccurrenceAfter(
      rrule,
      Date.parse('2026-01-01T00:00:00Z'),
      after,
      timezone
    )
    runs.push(new Date(after).toISOString())
  }
  return runs
}

// Why: on Windows, unsetting a stubbed TZ doesn't restore the OS zone, so it would leak into later tests.
describe.skipIf(process.platform === 'win32')(
  'an automation in another timezone than its host',
  () => {
    it('runs on its own wall clock, through both zones changing their clocks', () => {
      vi.stubEnv('TZ', 'America/New_York')
      // London leaves summer time on Oct 25, New York on Nov 1; 9:00 London stays 9:00 London.
      expect(
        nextRuns('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'Europe/London', '2026-10-23T12:00:00Z', 4)
      ).toEqual([
        '2026-10-24T08:00:00.000Z',
        '2026-10-25T09:00:00.000Z',
        '2026-10-26T09:00:00.000Z',
        '2026-10-27T09:00:00.000Z'
      ])
    })

    it('reads weekdays and cron fields in its own zone', () => {
      vi.stubEnv('TZ', 'UTC')
      // 9:00 Monday in Tokyo is still Sunday in UTC.
      expect(
        nextRuns(
          'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
          'Asia/Tokyo',
          '2026-11-01T00:00:00Z',
          1
        )
      ).toEqual(['2026-11-02T00:00:00.000Z'])
      expect(nextRuns('30 9 * * 1-5', 'Asia/Tokyo', '2026-11-06T12:00:00Z', 2)).toEqual([
        '2026-11-09T00:30:00.000Z',
        '2026-11-10T00:30:00.000Z'
      ])
      expect(
        nextRuns('FREQ=HOURLY;BYMINUTE=15', 'Asia/Kolkata', '2026-11-06T12:00:00Z', 1)
      ).toEqual(['2026-11-06T12:45:00.000Z'])
    })

    it.each([
      // Spring forward: 2:30 never happens, so it runs at 3:30, as the host's own clock would.
      ['FREQ=DAILY;BYHOUR=2;BYMINUTE=30', '2026-03-08T00:00:00Z', '2026-03-08T07:30:00.000Z'],
      // Fall back: 1:30 happens twice; it runs at the first.
      ['FREQ=DAILY;BYHOUR=1;BYMINUTE=30', '2026-11-01T00:00:00Z', '2026-11-01T05:30:00.000Z'],
      // The first wall-clock 3:00 after spring forward is the instant of the change.
      ['0 3 8 3 *', '2026-03-08T00:00:00Z', '2026-03-08T07:00:00.000Z']
    ])('resolves %s around a clock change like the host clock does', (rrule, from, expected) => {
      vi.stubEnv('TZ', 'UTC')
      expect(nextRuns(rrule, 'America/New_York', from, 1)).toEqual([expected])
      vi.stubEnv('TZ', 'America/New_York')
      expect(nextRuns(rrule, 'America/New_York', from, 1)).toEqual([expected])
    })

    it('keeps the host clock for a zone it does not know', () => {
      vi.stubEnv('TZ', 'UTC')
      expect(
        nextRuns('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'Mars/Olympus', '2026-11-01T00:00:00Z', 1)
      ).toEqual(['2026-11-01T09:00:00.000Z'])
    })
  }
)
