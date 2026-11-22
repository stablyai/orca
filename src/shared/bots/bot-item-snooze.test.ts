import { afterEach, describe, expect, it } from 'vitest'
import {
  botItemSnoozeDayRange,
  botItemSnoozePickerPresets,
  botItemSnoozeSlots
} from './bot-item-snooze'

const priorTz = process.env.TZ
afterEach(() => {
  if (priorTz === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = priorTz
  }
})

const iso = (at: number): string => new Date(at).toISOString()

describe('botItemSnoozePickerPresets', () => {
  it('resolves late-evening presets in the local zone, rolling Later today into tomorrow', () => {
    process.env.TZ = 'America/New_York'
    // Wed Nov 18, 10:30 PM in New York.
    const presets = botItemSnoozePickerPresets(Date.parse('2026-11-19T03:30:00Z'))
    expect(presets.map((preset) => [preset.id, iso(preset.at), preset.inHours])).toEqual([
      ['later', '2026-11-19T07:00:00.000Z', 3],
      ['tomorrow', '2026-11-19T14:00:00.000Z', undefined],
      ['monday', '2026-11-23T14:00:00.000Z', undefined],
      ['week', '2026-11-25T14:00:00.000Z', undefined]
    ])
  })

  it('drops Monday on a Monday, where it would repeat In a week', () => {
    process.env.TZ = 'UTC'
    // Mon Nov 23, 10:00 AM.
    const presets = botItemSnoozePickerPresets(Date.parse('2026-11-23T10:00:00Z'))
    expect(presets.map((preset) => [preset.id, iso(preset.at)])).toEqual([
      ['later', '2026-11-23T18:00:00.000Z'],
      ['tomorrow', '2026-11-24T09:00:00.000Z'],
      ['week', '2026-11-30T09:00:00.000Z']
    ])
  })
})

describe('picked times', () => {
  it('starts the day range tomorrow once today has no slot left', () => {
    process.env.TZ = 'UTC'
    const range = botItemSnoozeDayRange(Date.parse('2026-11-18T23:50:00Z'))
    expect(iso(range.first.getTime())).toBe('2026-11-19T00:00:00.000Z')
    expect(iso(range.last.getTime())).toBe('2027-11-19T00:00:00.000Z')
  })

  it('skips the hour a spring-forward change removes', () => {
    process.env.TZ = 'America/New_York'
    const slots = botItemSnoozeSlots(new Date(2026, 2, 8), Date.parse('2026-03-07T17:00:00Z'))
    expect(slots).toHaveLength(92)
    expect(slots).not.toContain(2 * 60)
    expect(slots).toContain(3 * 60)
  })
})
