import { describe, expect, it } from 'vitest'
import { formatUsageLimitResetClock } from './agent-session-usage-limit'

describe('formatUsageLimitResetClock', () => {
  // Local-zone dates and a pinned locale keep the wording the same on any host.
  const resetsAt = new Date(2026, 9, 28, 18, 39).getTime()

  it('includes the date only when the reset is on another local day', () => {
    expect(
      formatUsageLimitResetClock(resetsAt, new Date(2026, 9, 28, 18, 18).getTime(), 'en-US')
    ).toBe('6:39 PM')

    // ICU builds join the day and time with ", " or " at ".
    expect(
      formatUsageLimitResetClock(resetsAt, new Date(2026, 9, 29, 9, 0).getTime(), 'en-US')
    ).toMatch(/^Wed, Oct 28(,| at) 6:39 PM$/)
  })
})
