// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { InlineUsageBars } from './InlineProviderUsage'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: string }) => unknown) =>
    selector({ usagePercentageDisplay: 'remaining' })
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

const NOW = Date.UTC(2026, 8, 18, 12)
const MINUTE = 60_000

/** Omit the session window to verify weekly countdowns schedule their own updates. */
function limitsFor(window: 'weekly' | 'fableWeekly', resetsAt: number | null): ProviderRateLimits {
  return {
    provider: window === 'weekly' ? 'codex' : 'claude',
    session: null,
    weekly: null,
    [window]: { usedPercent: 100, windowMinutes: 10080, resetsAt, resetDescription: null },
    status: 'ok',
    error: null,
    updatedAt: NOW
  }
}

const NAME = { session: 'Session', weekly: 'Weekly', fableWeekly: 'Fable' } as const

describe('account row reset countdowns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each(['weekly', 'fableWeekly'] as const)(
    'ticks %s without a session window or a usage refresh',
    (window) => {
      render(
        <InlineUsageBars limits={limitsFor(window, NOW + 80 * MINUTE + 5000)} isFetching={false} />
      )
      expect(screen.getByText(`${NAME[window]} 1h 20m`)).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(5001)
      })
      expect(screen.getByText(`${NAME[window]} 1h 19m`)).toBeTruthy()
    }
  )

  it.each(['weekly', 'fableWeekly'] as const)(
    'keeps the %s label when the reset time is unknown',
    (window) => {
      render(<InlineUsageBars limits={limitsFor(window, null)} isFetching={false} />)
      expect(screen.getByText(window === 'weekly' ? 'wk' : NAME[window])).toBeTruthy()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['weekly', 'fableWeekly'] as const)(
    'shows an expired %s reset without negative time',
    (window) => {
      render(<InlineUsageBars limits={limitsFor(window, NOW - MINUTE)} isFetching={false} />)
      expect(screen.getByText(`${NAME[window]} now`)).toBeTruthy()
    }
  )

  it('names every window when session, weekly, and Fable resets are all known', () => {
    const limits = limitsFor('weekly', NOW + 2 * 24 * 60 * MINUTE)
    limits.session = {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: NOW + 119 * MINUTE,
      resetDescription: null
    }
    limits.fableWeekly = {
      usedPercent: 50,
      windowMinutes: 10080,
      resetsAt: NOW + 80 * MINUTE,
      resetDescription: null
    }
    render(<InlineUsageBars limits={limits} isFetching={false} />)
    expect(screen.getByText(`${NAME.session} 1h 59m`)).toBeTruthy()
    expect(screen.getByText(`${NAME.weekly} 2d`)).toBeTruthy()
    expect(screen.getByText(`${NAME.fableWeekly} 1h 20m`)).toBeTruthy()
  })
})
