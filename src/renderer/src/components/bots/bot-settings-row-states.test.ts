import { describe, expect, it } from 'vitest'
import { lookAroundLine } from './bot-settings-row-states'

// Local wall-clock times, so "today" and "yesterday" hold in any time zone.
const now = new Date(2026, 10, 10, 15, 0).getTime()
const today = new Date(2026, 10, 10, 12, 4).getTime()
const yesterday = new Date(2026, 10, 9, 16, 12).getTime()
const earlier = new Date(2026, 9, 29, 9, 0).getTime()
const look = { on: true, every: 'every-4h', weekdaysOnly: true, focus: '' } as const

describe('bot settings Look around line', () => {
  it('says when Look around runs and when it last looked', () => {
    expect(lookAroundLine(look, today, undefined, now)).toBe(
      'Every 4 hours on weekdays, 8 AM to 8 PM · last looked 12:04 PM'
    )
    expect(lookAroundLine(look, yesterday, undefined, now)).toBe(
      'Every 4 hours on weekdays, 8 AM to 8 PM · last looked yesterday 4:12 PM'
    )
    expect(
      lookAroundLine({ ...look, every: 'custom', times: ['14:00', '09:30'] }, earlier, 'UTC', now)
    ).toBe('Weekdays at 9:30 AM and 2 PM (UTC) · last looked Oct 29')
    expect(lookAroundLine(look, undefined, undefined, now)).toBe(
      'Every 4 hours on weekdays, 8 AM to 8 PM'
    )
    expect(lookAroundLine({ ...look, on: false }, today, undefined, now)).toBe('Off')
  })
})
