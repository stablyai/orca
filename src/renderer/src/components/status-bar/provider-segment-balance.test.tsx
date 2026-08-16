import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

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

function openCodeGo(sessionUsedPercent: number): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: {
      usedPercent: sessionUsedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    extraUsage: {
      balance: 12.4,
      unit: 'currency',
      currencyCode: 'USD',
      enabled: true,
      disabledReason: null,
      spent: null,
      spendLimit: null,
      spentPercent: null,
      resetsAt: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

function codexCredits(sessionUsedPercent: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: {
      usedPercent: sessionUsedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    extraUsage: {
      balance: 500,
      unit: 'credits',
      unlimited: false,
      enabled: true,
      disabledReason: null,
      resetsAt: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

function claudeDisabledCredits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    extraUsage: {
      balance: 0,
      unit: 'currency',
      currencyCode: 'EUR',
      enabled: false,
      disabledReason: 'out_of_credits',
      spent: 0,
      spendLimit: 2000,
      spentPercent: 0,
      resetsAt: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('ProviderSegment extra-usage balance token', () => {
  it('reveals the remaining balance once a plan window is capped', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={openCodeGo(100)} compact={false} display="used" />
    )

    expect(markup).toContain('$12.40')
    expect(markup).toContain('bal')
  })

  it('hides the balance while plan windows still have headroom', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={openCodeGo(20)} compact={false} display="used" />
    )

    expect(markup).not.toContain('$12.40')
    expect(markup).not.toContain('bal')
  })

  it('does not reveal a disabled balance even when a window is capped', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeDisabledCredits()} compact={false} display="used" />
    )

    expect(markup).not.toContain('bal')
  })

  it('reveals a Codex credit count (not a currency amount) when a window caps', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={codexCredits(100)} compact={false} display="used" />
    )

    expect(markup).toContain('500 credits')
    expect(markup).not.toContain('$500')
    expect(markup).not.toContain('bal')
  })
})
