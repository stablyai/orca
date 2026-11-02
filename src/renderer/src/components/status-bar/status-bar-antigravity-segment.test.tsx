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

const WEEKLY_MINUTES = 10_080

function weeklyWindow(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: WEEKLY_MINUTES, resetsAt: null, resetDescription: null }
}

/** Captured agy 1.2.11 weekly-only tier with an exhausted Gemini pool. */
function antigravityLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: weeklyWindow(100),
    buckets: [
      { name: 'Gemini Models', ...weeklyWindow(100) },
      { name: 'Claude and GPT models', ...weeklyWindow(0) }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('Antigravity status-bar segment', () => {
  it('renders both model-group pools by name', async () => {
    // Tier-specific Antigravity pool names cannot use Gemini’s experimental-model allowlist.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('Gemini Models')
    expect(markup).toContain('Claude and GPT models')
    expect(markup).toContain('100%')
  })

  it('does not widen the allowlist for providers that rely on it', async () => {
    // Only whole-meter bucket providers bypass the Gemini experimental-pool allowlist.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={{
          provider: 'gemini',
          session: weeklyWindow(12),
          weekly: null,
          buckets: [
            { name: 'Pro', ...weeklyWindow(30) },
            { name: 'Some Experimental Model', ...weeklyWindow(80) }
          ],
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('Pro')
    expect(markup).not.toContain('Some Experimental Model')
  })
})
