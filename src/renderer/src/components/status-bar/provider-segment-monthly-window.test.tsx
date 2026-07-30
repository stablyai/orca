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

    expect(markup).toContain('25% used 30d')
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

    expect(markup).toContain('25% used 30d')
    expect(markup).not.toContain('···')
  })

  it('shows only the highest-used window when several windows exist', async () => {
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

    expect(markup).toContain('30% used 30d')
    expect(markup).not.toContain('10% used')
    expect(markup).not.toContain('20% used')
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

    expect(markup).toContain('80% used Pro')
    expect(markup).not.toContain('25% used')
  })

  // Why: #8378 — status-bar chip showed fixed window size ("5h") while the
  // usage popup showed remaining time for the same resetsAt.
  it('shows remaining session time on the chip when resetsAt is known (repro-8378)', async () => {
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

      expect(markup).toContain('42% used 2h 33m')
      expect(markup).not.toContain('5h')
      // The consolidated footer intentionally renders only the tightest window.
      expect(markup).not.toContain('10% used')
      expect(markup).not.toContain('wk')
    } finally {
      dateNow.mockRestore()
    }
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

    expect(markup).toContain('10% used 5h')
    expect(markup).toContain('20% used wk')
    expect(markup).toContain('30% used Fable')
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
