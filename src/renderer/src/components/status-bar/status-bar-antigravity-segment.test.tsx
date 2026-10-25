import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  getIntlLocale: () => 'en',
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

const FIVE_HOUR_MINUTES = 300

/** A tier with a 5h and a weekly pool per group, from a host that publishes `group`/`windowName`. */
function groupedLimits(): ProviderRateLimits {
  const pool = (group: string, windowMinutes: number, usedPercent: number) => {
    const windowName =
      windowMinutes === FIVE_HOUR_MINUTES ? '5h Limit Remaining' : 'Weekly Limit Remaining'
    return {
      name: `${group} · ${windowName}`,
      group,
      windowName,
      ...weeklyWindow(usedPercent),
      windowMinutes
    }
  }
  return antigravityLimits({
    weekly: weeklyWindow(4),
    buckets: [
      pool('Gemini Models', WEEKLY_MINUTES, 4),
      pool('Gemini Models', FIVE_HOUR_MINUTES, 0),
      pool('Claude and GPT models', WEEKLY_MINUTES, 0),
      pool('Claude and GPT models', FIVE_HOUR_MINUTES, 0)
    ]
  })
}

describe('Antigravity status-bar segment', () => {
  it('renders both model-group pools by name', async () => {
    // Why: the verbose bucket allowlist was written for Gemini's experimental models, so
    // Antigravity's pools — whose names come from the account's tier and cannot be enumerated
    // ahead of time — were filtered out and the segment showed no number at all.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={antigravityLimits()} compact={false} display="used" mode="verbose" />
    )

    expect(markup).toContain('Gemini Models')
    expect(markup).toContain('Claude and GPT models')
    expect(markup).toContain('100%')
  })

  it('labels grouped pools by short group and window length', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={groupedLimits()} compact={false} display="used" mode="verbose" />
    )

    // Why '>Gemini<': the group's `title` still holds the full name, so a bare match is vacuous.
    expect(markup).toContain('>Gemini<')
    expect(markup).toContain('>Claude/GPT<')
    expect(markup).toContain('5h')
    expect(markup).toContain('4%')
    expect(markup).not.toContain('Gemini Models ·')
    expect(markup).not.toContain('Limit Remaining')
    // 5h sorts before wk within a group.
    expect(markup.indexOf('5h')).toBeLessThan(markup.indexOf('wk'))
  })

  it('uses the short pool label in compact mode', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={groupedLimits()} compact={false} display="used" mode="compact" />
    )

    expect(markup).toContain('4%')
    expect(markup).toContain('Gemini wk')
    expect(markup).not.toContain('Limit Remaining')
  })

  it('renders no pool label when the compact bar hides labels', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={groupedLimits()} compact display="used" mode="compact" />
    )

    expect(markup).toContain('4%')
    expect(markup).not.toContain('Gemini')
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
