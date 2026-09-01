import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageFormat } from '../../../../shared/status-bar-usage-format'

let statusBarUsageFormat: StatusBarUsageFormat = { template: '' }

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
  useAppStore: (
    selector: (state: {
      usagePercentageDisplay: 'used' | 'remaining'
      statusBarUsageFormat: StatusBarUsageFormat
    }) => unknown
  ) => selector({ usagePercentageDisplay: 'used', statusBarUsageFormat })
}))

/** Rate-limit window fixture with only the fields the template reads. */
function windowOf(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

/** Claude limits fixture covering the 5h and 7d windows. */
function claudeLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: windowOf(14, 300),
    weekly: windowOf(20, 10080),
    fableWeekly: windowOf(37, 10080),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('ProviderSegment usage format template', () => {
  it('renders the user template instead of the built-in window labels', async () => {
    statusBarUsageFormat = { template: '{provider} | 5h: {5h} | 7d: {7d}[ | Fable: {fable}]' }
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeLimits()} compact={false} display="used" mode="verbose" />
    )
    expect(markup).toContain('Claude | 5h: 14% | 7d: 20% | Fable: 37%')
    expect(markup).not.toContain('14% used')
    // Why: multiple spaces in the template must survive HTML whitespace collapsing.
    expect(markup).toMatch(/<span class="[^"]*whitespace-pre[^"]*">Claude \| 5h/)
  })

  it('honors the template in compact usage mode instead of the tightest-window label', async () => {
    statusBarUsageFormat = { template: '{provider} {5h}/{7d}' }
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeLimits()} compact={false} display="used" mode="compact" />
    )
    expect(markup).toContain('Claude 14%/20%')
    expect(markup).not.toContain('37% used Fable')
  })

  it('falls back to the built-in rendering when the template is empty', async () => {
    statusBarUsageFormat = { template: '   ' }
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeLimits()} compact={false} display="used" mode="verbose" />
    )
    expect(markup).toContain('14% used')
  })
})
