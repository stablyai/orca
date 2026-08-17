import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

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

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

/** Why: React separates adjacent text nodes with comment markers; assert on the visible text. */
function textOf(markup: string): string {
  return markup.replace(/<!--.*?-->/g, '').replace(/<[^>]*>/g, '')
}

function windowOf(
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null
): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

function claudeLimitsWithFable(): ProviderRateLimits {
  const now = Date.now()
  return {
    provider: 'claude',
    session: windowOf(10, 300, now + 4 * 60 * 60 * 1000),
    weekly: windowOf(20, 10080, now + 2 * 24 * 60 * 60 * 1000),
    fableWeekly: windowOf(30, 10080, now + 3 * 24 * 60 * 60 * 1000),
    monthly: null,
    updatedAt: now,
    error: null,
    status: 'ok'
  }
}

describe('ProviderSegment Fable chip', () => {
  // Why: the session and weekly chips beside it are live reset countdowns, so a bare "Fable"
  // reads as a missing value rather than a label (#13041).
  it('shows the Fable reset countdown, not just the word', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeLimitsWithFable()} compact={true} display="used" mode="verbose" />
    )

    // Why: a live countdown formats as "2d" or "1d 23h" depending on the millisecond the test
    // renders, so assert a duration follows the name rather than a wall-clock value.
    expect(textOf(markup)).toMatch(/30% used Fable \d+[dhm]/)
  })

  it('keeps the Fable name so the chip stays distinct from the plain weekly one', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeLimitsWithFable()} compact={true} display="used" mode="verbose" />
    )

    expect(textOf(markup)).toMatch(/20% used \d+[dhm]/)
    expect(textOf(markup)).toContain('Fable')
  })

  it('falls back to the window length when Claude reports no reset timestamp', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits = claudeLimitsWithFable()
    limits.fableWeekly = windowOf(30, 10080, null)

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={true} display="used" mode="verbose" />
    )

    expect(textOf(markup)).toContain('30% used Fable wk')
  })
})
