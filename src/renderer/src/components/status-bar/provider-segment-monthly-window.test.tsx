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

function windowOf(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
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
      <ProviderSegment p={grokMonthlyLimits('ok')} compact={false} display="used" />
    )

    expect(markup).toContain('25% used 30d')
  })

  it('shows monthly data while fetching instead of the loading placeholder', async () => {
    const { ProviderSegment } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <ProviderSegment p={grokMonthlyLimits('fetching')} compact={false} display="used" />
    )

    expect(markup).toContain('25% used 30d')
    expect(markup).not.toContain('···')
  })

  // Why: providers with session/weekly windows (OpenCode Go) keep monthly
  // tooltip-only so the chip stays uncluttered.
  it('keeps monthly out of the chip when session and weekly windows exist', async () => {
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
      <ProviderSegment p={limits} compact={false} display="used" />
    )

    expect(markup).toContain('10% used 5h')
    expect(markup).toContain('20% used wk')
    expect(markup).not.toContain('30d')
  })
})
