import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const mocks = vi.hoisted(() => ({
  usagePercentageDisplay: 'used' as 'used' | 'remaining'
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: mocks.usagePercentageDisplay })
}))

function claudeLimits(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: {
      usedPercent: 32,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: 16,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    fableWeekly: {
      usedPercent: 42,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('InlineUsageBars', () => {
  beforeEach(() => {
    mocks.usagePercentageDisplay = 'used'
  })

  it('renders Claude Fable usage in inactive account preview rows', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    // Why: bars show % used with explicit "used" so compact labels are not ambiguous.
    expect(markup).toContain('32% used 5h')
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
  })

  it('shows remaining copy and remaining meter fill', async () => {
    mocks.usagePercentageDisplay = 'remaining'
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    expect(markup).toContain('68% left 5h')
    expect(markup).toContain('84% left wk')
    expect(markup).toContain('58% left Fable')
    expect(markup).toContain('width:68%')
    expect(markup).toContain('width:84%')
    expect(markup).toContain('width:58%')
    expect(markup).not.toContain('width:32%')
  })
})
