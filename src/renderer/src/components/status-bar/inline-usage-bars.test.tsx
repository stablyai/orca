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

    expect(markup).toContain('32% used 5h')
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
  })

  it('asks for a sign-in when another provider has no usage to show', async () => {
    const { InlineUsageBars } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Not signed in',
      status: 'error'
    }

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('Sign in to see usage')
  })

  // Why: an idle account's access token lapses overnight while its login stays valid; Claude refreshes it on its next run.
  it.each(['profile:idle', 'system', 'wsl:Ubuntu:system'])(
    'does not ask a Claude account with an expired usage token (%s) to sign in',
    async (authProvenance) => {
      const { InlineUsageBars } = await import('./StatusBar')
      const limits: ProviderRateLimits = {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: 0,
        // An older host's wording; the row speaks from the failure kind.
        error: 'Claude usage has expired. Start Claude in this account to refresh it.',
        status: 'error',
        usageMetadata: {
          failureKind: 'stale-token',
          attemptedSources: ['oauth'],
          authProvenance
        }
      }

      const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

      expect(markup).not.toContain('Sign in to see usage')
      expect(markup).toContain('Updates when Claude runs')
    }
  )

  it.each([
    { failureKind: 'missing-credentials' as const, label: 'Sign in to see usage' },
    { failureKind: 'network' as const, label: 'Network issue' }
  ])('labels a Claude row with no usage by its $failureKind failure', async (row) => {
    const { InlineUsageBars } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 0,
      error: 'Claude usage is unavailable.',
      status: 'error',
      usageMetadata: { failureKind: row.failureKind }
    }

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain(row.label)
  })

  it('renders the spend-cap monthly window for an inactive account without plan windows', async () => {
    const { InlineUsageBars, isUnavailableInactiveUsage } = await import('./InlineProviderUsage')
    const limits: ProviderRateLimits = {
      provider: 'claude',
      session: null,
      weekly: null,
      monthly: { usedPercent: 80, windowMinutes: 43_200, resetsAt: null, resetDescription: null },
      updatedAt: 0,
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('80% used 30d')
    expect(markup).not.toContain('Sign in to see usage')
    expect(isUnavailableInactiveUsage({ ...limits, status: 'error' })).toBe(false)
  })

  it('keeps the monthly window out of rows that have plan windows', async () => {
    const { InlineUsageBars } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      ...claudeLimits(),
      monthly: { usedPercent: 80, windowMinutes: 43_200, resetsAt: null, resetDescription: null }
    }

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).not.toContain('80% used')
  })

  it('derives the collapsed session label from resetsAt (#5399)', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    // Buffer the floor-based countdown so snapshot-to-render delay cannot lose a minute.
    limits.session!.resetsAt = Date.now() + 80 * 60_000 + 5_000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('32% used 1h 20m')
    expect(markup).not.toContain('32% used 5h')
    expect(markup).toContain('16% used wk')
    expect(markup).toContain('42% used Fable')
  })

  it('shows "now" for an already-expired session reset', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    limits.session!.resetsAt = Date.now() - 1000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('32% used now')
  })

  it('keeps the footer meter for weekly-only Codex usage', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const limits: ProviderRateLimits = {
      provider: 'codex',
      session: null,
      weekly: {
        usedPercent: 37,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="used" />
    )

    expect(markup).toContain('w-[48px] h-[6px]')
    expect(markup).toContain('width:37%')
    expect(markup).toContain('37% wk')
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
