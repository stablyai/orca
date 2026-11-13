import { describe, expect, it } from 'vitest'
import { claudeRateLimitEventUsage } from './claude-statusline-rate-limits'

describe('claudeRateLimitEventUsage', () => {
  it('reads stream-json unified windows as statusline percentages', () => {
    const frame = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        unifiedWindows: {
          five_hour: { utilization: 0.08, resetsAt: 1794549000, status: 'allowed' },
          seven_day: { utilization: 0.24, resetsAt: 1794855600, status: 'allowed' }
        }
      }
    }

    expect(claudeRateLimitEventUsage(frame, null)).toEqual({
      configDir: null,
      fiveHour: { utilization: 8, resets_at: 1794549000 },
      sevenDay: { utilization: 24, resets_at: 1794855600 }
    })
  })

  it('ignores frames without unified windows', () => {
    const frame = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }

    expect(claudeRateLimitEventUsage(frame, null)).toBeNull()
  })
})
