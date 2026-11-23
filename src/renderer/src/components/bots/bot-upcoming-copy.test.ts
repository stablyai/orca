import { describe, expect, it } from 'vitest'

import { everyText } from './bot-upcoming-copy'

describe('everyText', () => {
  it('says the schedule the setting runs on, days and hours included', () => {
    expect(everyText({ every: 'every-4h', weekdaysOnly: true })).toBe(
      'weekdays, 8 AM to 8 PM, every 4 hours'
    )
    expect(everyText({ every: 'twice-daily', weekdaysOnly: false })).toBe(
      'twice a day, 8 AM and 1 PM'
    )
  })
})
