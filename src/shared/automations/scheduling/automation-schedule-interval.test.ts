import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

afterEach(() => vi.unstubAllEnvs())

const BIWEEKLY = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'

// Each case runs host-local in New York and zoned to New York from a UTC host.
const MODES = [
  { name: 'host-local', hostTz: 'America/New_York', timezone: undefined },
  { name: 'zoned', hostTz: 'UTC', timezone: 'America/New_York' }
] as const

// Why: on Windows, unsetting a stubbed TZ doesn't restore the OS zone, so it would leak into later tests.
describe.skipIf(process.platform === 'win32').each(MODES)(
  'INTERVAL rules ($name)',
  ({ hostTz, timezone }) => {
    function runs(rule: string, dtstartIso: string, fromIso: string, count: number): string[] {
      vi.stubEnv('TZ', hostTz)
      const result: string[] = []
      let after = Date.parse(fromIso)
      for (let index = 0; index < count; index += 1) {
        after = nextAutomationOccurrenceAfter(rule, Date.parse(dtstartIso), after, timezone)
        result.push(new Date(after).toISOString())
      }
      return result
    }

    it('runs biweekly from the week of dtstart', () => {
      expect(runs(BIWEEKLY, '2026-11-04T00:00:00-05:00', '2026-11-04T00:00:00-05:00', 3)).toEqual([
        '2026-11-04T16:00:00.000Z',
        '2026-11-18T16:00:00.000Z',
        '2026-12-02T16:00:00.000Z'
      ])
    })

    it('counts the Monday week of a mid-week dtstart as week 1', () => {
      expect(runs(BIWEEKLY, '2026-11-12T00:00:00-05:00', '2026-11-12T00:00:00-05:00', 2)).toEqual([
        '2026-11-25T16:00:00.000Z',
        '2026-12-09T16:00:00.000Z'
      ])
    })

    it('runs biweekly across the year boundary', () => {
      expect(runs(BIWEEKLY, '2026-12-23T00:00:00-05:00', '2026-12-23T00:00:00-05:00', 3)).toEqual([
        '2026-12-23T16:00:00.000Z',
        '2027-01-06T16:00:00.000Z',
        '2027-01-20T16:00:00.000Z'
      ])
    })

    it('keeps 11:00 wall time across fall back', () => {
      expect(runs(BIWEEKLY, '2026-10-28T00:00:00-04:00', '2026-10-28T00:00:00-04:00', 2)).toEqual([
        '2026-10-28T15:00:00.000Z',
        '2026-11-11T16:00:00.000Z'
      ])
    })

    it('runs every 2 days across spring forward', () => {
      expect(
        runs(
          'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0',
          '2027-03-13T00:00:00-05:00',
          '2027-03-13T00:00:00-05:00',
          3
        )
      ).toEqual([
        '2027-03-13T14:00:00.000Z',
        '2027-03-15T13:00:00.000Z',
        '2027-03-17T13:00:00.000Z'
      ])
    })

    it.each([
      // 00:30 EDT, 02:30 EST
      ['2026-11-01T00:00:00-04:00', ['2026-11-01T04:30:00.000Z', '2026-11-01T07:30:00.000Z']],
      // 01:30 EDT, 03:30 EST; not 01:30 EST
      ['2026-11-01T01:00:00-04:00', ['2026-11-01T05:30:00.000Z', '2026-11-01T08:30:00.000Z']]
    ])('every 2 hours from %s runs once per wall slot across fall back', (dtstart, expected) => {
      expect(runs('FREQ=HOURLY;INTERVAL=2;BYMINUTE=30', dtstart, dtstart, 2)).toEqual(expected)
    })

    it('finds the latest on-week run for missed-run grace', () => {
      vi.stubEnv('TZ', hostTz)
      const dtstart = Date.parse('2026-11-04T00:00:00-05:00')
      // Wed Nov 11 is an off week.
      expect(
        latestAutomationOccurrenceAtOrBefore(
          BIWEEKLY,
          dtstart,
          Date.parse('2026-11-12T12:00:00-05:00'),
          timezone
        )
      ).toBe(Date.parse('2026-11-04T11:00:00-05:00'))
    })
  }
)

// Troll falls back two hours (03:00 +02 to 01:00 +00), so a one-hour lookback can't see the repeat.
it.skipIf(process.platform === 'win32')(
  'every 2 hours runs local 01:30 once across a two-hour fall back',
  () => {
    vi.stubEnv('TZ', 'UTC')
    const rule = 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=30'
    const dtstart = Date.parse('2026-10-24T23:00:00Z')
    const first = nextAutomationOccurrenceAfter(rule, dtstart, dtstart, 'Antarctica/Troll')
    const second = nextAutomationOccurrenceAfter(rule, dtstart, first, 'Antarctica/Troll')
    expect([first, second].map((run) => new Date(run).toISOString())).toEqual([
      '2026-10-24T23:30:00.000Z',
      '2026-10-25T03:30:00.000Z'
    ])
  }
)
