import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from './rate-limit-types'
import { getRateLimitWindowPace } from './rate-limit-window-pace'

const FIVE_HOURS_MS = 300 * 60_000

function sessionWindow(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 0,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null,
    ...overrides
  }
}

describe('getRateLimitWindowPace', () => {
  it('computes elapsed percent from resetsAt and the window duration', () => {
    const now = 1_000_000
    const pace = getRateLimitWindowPace(
      sessionWindow({ usedPercent: 20, resetsAt: now + FIVE_HOURS_MS / 2 }),
      now
    )
    expect(pace).not.toBeNull()
    expect(pace!.elapsedPercent).toBeCloseTo(50)
    expect(pace!.overPace).toBe(false)
  })

  it('flags over-pace only when consumption runs ahead of elapsed time', () => {
    const now = 1_000_000
    const halfway = sessionWindow({ resetsAt: now + FIVE_HOURS_MS / 2 })
    expect(getRateLimitWindowPace({ ...halfway, usedPercent: 51 }, now)!.overPace).toBe(true)
    // Exactly on pace stays green.
    expect(getRateLimitWindowPace({ ...halfway, usedPercent: 50 }, now)!.overPace).toBe(false)
  })

  it('rounds usedPercent like the displayed label before comparing pace', () => {
    const now = 1_000_000
    const halfway = sessionWindow({ resetsAt: now + FIVE_HOURS_MS / 2 })
    // 50.4 displays as 50% — the tick must not contradict the label.
    expect(getRateLimitWindowPace({ ...halfway, usedPercent: 50.4 }, now)!.overPace).toBe(false)
  })

  it('returns null without a usable reset timestamp', () => {
    const now = 1_000_000
    expect(getRateLimitWindowPace(sessionWindow({ resetsAt: null }), now)).toBeNull()
    expect(getRateLimitWindowPace(sessionWindow({ resetsAt: Number.NaN }), now)).toBeNull()
  })

  it('returns null for a stale window whose reset already passed', () => {
    const now = 1_000_000
    expect(getRateLimitWindowPace(sessionWindow({ resetsAt: now - 1 }), now)).toBeNull()
    expect(getRateLimitWindowPace(sessionWindow({ resetsAt: now }), now)).toBeNull()
  })

  it('returns null for calendar billing windows longer than 7 days', () => {
    const now = 1_000_000
    // Monthly periods last 28–31 days; a nominal 30d duration would fabricate
    // the window start, so no pace is reported.
    expect(
      getRateLimitWindowPace(
        sessionWindow({ windowMinutes: 43200, resetsAt: now + 15 * 24 * 60 * 60_000 }),
        now
      )
    ).toBeNull()
  })

  it('returns null when reset and duration are inconsistent', () => {
    const now = 1_000_000
    // Derived Codex/MiniMax window lengths can disagree with resetsAt.
    expect(
      getRateLimitWindowPace(sessionWindow({ resetsAt: now + FIVE_HOURS_MS + 60_000 }), now)
    ).toBeNull()
    expect(
      getRateLimitWindowPace(sessionWindow({ windowMinutes: 0, resetsAt: now + 60_000 }), now)
    ).toBeNull()
    // NaN passes both relational bounds; it must not render as `left:NaN%`.
    expect(
      getRateLimitWindowPace(
        sessionWindow({ windowMinutes: Number.NaN, resetsAt: now + 60_000 }),
        now
      )
    ).toBeNull()
  })
})
