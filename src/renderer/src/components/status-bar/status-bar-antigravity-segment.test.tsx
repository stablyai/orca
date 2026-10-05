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

/**
 * The record `agy -p "/usage"` produces for a tier metered weekly only, with the Gemini pool
 * genuinely exhausted — captured from agy 1.2.11.
 */
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
  it('renders every model-group pool in the Claude/Codex window format', async () => {
    // Why: the verbose bucket allowlist was written for Gemini's experimental models, so
    // Antigravity's pools — whose names come from the account's tier and cannot be enumerated
    // ahead of time — were filtered out and the segment showed no number at all.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    // Why: long tier group names crowded the footer; they stay in the popover only.
    expect(markup).not.toContain('Gemini Models')
    expect(markup).not.toContain('Claude and GPT models')
    expect(markup).toContain('100% wk')
    expect(markup).toContain('>0% wk')
  })

  it('shows the pool reset time instead of its name in compact mode', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const now = 1_700_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const resetsAt = now + 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000
      const markup = renderToStaticMarkup(
        <ProviderSegment
          p={antigravityLimits({
            buckets: [
              { name: 'Gemini Models', ...weeklyWindow(100), resetsAt },
              { name: 'Claude and GPT models', ...weeklyWindow(0) }
            ]
          })}
          compact={false}
          display="used"
          mode="compact"
        />
      )

      expect(markup).toContain('100% 2d 3h')
      expect(markup).not.toContain('Gemini Models')
    } finally {
      dateNow.mockRestore()
    }
  })

  it('omits the time label for a pool whose window agy did not name', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({
          buckets: [{ name: 'Gemini Models', ...weeklyWindow(40), windowMinutes: 0 }]
        })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('40%</span>')
  })

  it('shows the weekly window when a tier reports no session pool', async () => {
    // Why: the verbose fallback chain was `session ?? monthly`, so a weekly-only provider with a
    // real limit rendered an empty segment.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: [] })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('still renders a reading when only the weekly window is known', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={antigravityLimits({ buckets: undefined })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )

    expect(markup).toContain('100%')
  })

  it('does not widen the allowlist for providers that rely on it', async () => {
    // Why: Gemini's experimental buckets are still filtered; only providers whose buckets are the
    // whole meter bypass the allowlist.
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
