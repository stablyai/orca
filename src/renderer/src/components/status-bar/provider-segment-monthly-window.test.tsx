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

function windowOf(
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null = null
): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

// Grok unified-billing accounts surface a monthly window and nothing else.
function grokMonthlyLimits(status: ProviderRateLimits['status']): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: null,
    monthly: windowOf(25, 43200),
    updatedAt: Date.now(),
    error: null,
    status
  }
}

describe('ProviderSegment monthly window', () => {
  it('renders a monthly-only snapshot in the chip instead of a bare icon', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={grokMonthlyLimits('ok')} compact={false} display="used" mode="compact" />
    )

    // Why: 43200 min = 30d; formatWindowLabel returns "30d" so the chip label lines up.
    expect(markup).toMatch(/30d[\s\S]*?25%/)
  })

  it('shows monthly data while fetching instead of the loading placeholder', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={grokMonthlyLimits('fetching')}
        compact={false}
        display="used"
        mode="compact"
      />
    )

    expect(markup).toMatch(/30d[\s\S]*?25%/)
    expect(markup).not.toContain('···')
  })

  it('prefers the session window in compact mode (#14264)', async () => {
    // Why: session resets every 5h vs weekly 7d — its countdown is more actionable even when a longer window is at higher consumption.
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'opencode-go',
      session: windowOf(10, 300),
      weekly: windowOf(20, 10080),
      monthly: windowOf(30, 43200),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
    )

    expect(markup).toMatch(/5h[\s\S]*?10%/)
    // Why: only the session chip renders so the footer stays single-line.
    expect(markup).not.toMatch(/wk[\s\S]*?20%/)
    expect(markup).not.toMatch(/30d[\s\S]*?30%/)
  })

  it('selects a named bucket as the tightest provider window', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'gemini',
      session: null,
      weekly: null,
      buckets: [
        { ...windowOf(25, 300), name: 'Flash' },
        { ...windowOf(80, 300), name: 'Pro' }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
    )

    // Why: named buckets keep their model name on the chip (a "5h" label for Pro/Flash reads as noise).
    expect(markup).toMatch(/Pro[\s\S]*?80%/)
    expect(markup).not.toMatch(/Flash[\s\S]*?25%/)
  })

  // Why: chip switched from reset-countdown ("2h 33m") to duration ("5h") for cross-provider consistency (#14264). Popover still shows countdown.
  it('shows the duration label on the chip when resetsAt is known (#14264 supersedes repro-8378)', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const now = 1_700_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const remainingMs = 2 * 60 * 60_000 + 33 * 60_000

    try {
      const limits: ProviderRateLimits = {
        provider: 'codex',
        session: windowOf(42, 300, now + remainingMs),
        weekly: windowOf(10, 10080, now + 6 * 24 * 60 * 60_000),
        updatedAt: now,
        error: null,
        status: 'ok'
      }
      const markup = renderToStaticMarkup(
        <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
      )

      // Why: 42% / 300-min window -> "5h [bar] 42%". Reset countdown still lives in the popover.
      expect(markup).toMatch(/5h[\s\S]*?42%/)
      // The consolidated footer intentionally renders only the tightest window.
      expect(markup).not.toMatch(/wk[\s\S]*?10%/)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('renders the bar on the tightest window in both modes', async () => {
    // Why: #14264 — each chip is "label [bar] percent" in both modes; the difference is just how many windows render.
    const { ProviderSegment } = await import('./StatusBar')
    const limits = grokMonthlyLimits('ok')

    const verbose = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="verbose" />
    )
    const compact = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
    )

    expect(verbose).toContain('data-usage-bar')
    expect(compact).toContain('data-usage-bar')
  })

  it('restores every inline window in verbose mode', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'claude',
      session: windowOf(10, 300),
      weekly: windowOf(20, 10_080),
      fableWeekly: windowOf(30, 10_080),
      monthly: windowOf(40, 43_200),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toMatch(/5h[\s\S]*?10%/)
    expect(markup).toMatch(/wk[\s\S]*?20%/)
    expect(markup).toMatch(/Fable[\s\S]*?30%/)
    expect(markup).not.toContain('40% used')
  })
})

describe('undefined provider window safety (crash d2c1da69 / bb74236c)', () => {
  // A partial/rehydrated provider can carry an undefined (not null) window even
  // though the type declares `session`/`weekly` as `RateLimitWindow | null`. The
  // old `s.window !== null` filter let the undefined-window section through, so
  // getTightestUsageSection's reduce read `.usedPercent` of undefined and crashed
  // the status-bar overlay (TypeError in ProviderSegment).
  const partialProvider = {
    provider: 'codex',
    weekly: windowOf(42, 10080),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  } as unknown as ProviderRateLimits // `session` omitted -> undefined at runtime

  it('getTightestUsageSection ignores an undefined window instead of crashing', async () => {
    const { getTightestUsageSection } = await import('./UsageRosterPanel')
    expect(() => getTightestUsageSection(partialProvider)).not.toThrow()
    expect(getTightestUsageSection(partialProvider)?.window.usedPercent).toBe(42)
  })

  it('ProviderSegment renders without crashing when a provider window is undefined', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    expect(() =>
      renderToStaticMarkup(
        <ProviderSegment p={partialProvider} compact={false} display="used" mode="compact" />
      )
    ).not.toThrow()
  })
})
