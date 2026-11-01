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

describe('ProviderSegment monthly window', () => {
  it('shows only the highest-used window when several windows exist', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const limits: ProviderRateLimits = {
      provider: 'opencode-go',
      session: windowOf(10, 300),
      weekly: windowOf(20, 10080),
      monthly: windowOf(30, 43200),
      updatedAt: 0,
      error: null,
      status: 'ok'
    }
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
    )

    expect(markup).toContain('>30% 30d<')
    expect(markup).not.toContain('>10%')
    expect(markup).not.toContain('>20%')
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
      updatedAt: 0,
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" mode="compact" />
    )

    expect(markup).toContain('>80% Pro<')
    expect(markup).not.toContain('>25%')
  })
})

describe('undefined provider window safety (crash d2c1da69 / bb74236c)', () => {
  // A partial/rehydrated provider can carry an undefined (not null) window even
  // though the type declares `session`/`weekly` as `RateLimitWindow | null`. The
  // old `s.window !== null` filter let the undefined-window section through, so
  // getTightestUsageSection's reduce read `.usedPercent` of undefined and crashed
  // the status-bar overlay (TypeError in ProviderSegment).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberately omit session to reproduce malformed persisted provider data.
  const partialProvider = {
    provider: 'codex',
    weekly: windowOf(42, 10080),
    updatedAt: 0,
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
