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
    expect(markup).toContain('>32% used</span>')
    expect(markup).toContain('>5h</span>')
    expect(markup).toContain('>16% used</span>')
    expect(markup).toContain('>wk</span>')
    expect(markup).toContain('>42% used</span>')
    expect(markup).toContain('>Fable</span>')
  })

  it('derives the collapsed session label from resetsAt (#5399)', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    // ~1h 20m away; +5s buffer keeps the floor-based formatter at '1h 20m'
    // across the few ms between snapshot and render.
    limits.session!.resetsAt = Date.now() + 80 * 60_000 + 5_000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('>32% used</span>')
    expect(markup).toContain('>Session 1h 20m</span>')
    expect(markup).not.toContain('>Session</span>')
    // Non-session bars keep their fixed labels.
    expect(markup).toContain('>16% used</span>')
    expect(markup).toContain('>wk</span>')
    expect(markup).toContain('>42% used</span>')
    expect(markup).toContain('>Fable</span>')
  })

  it('shows "now" for an already-expired session reset', async () => {
    const { InlineUsageBars } = await import('./StatusBar')

    const limits = claudeLimits()
    limits.session!.resetsAt = Date.now() - 1000

    const markup = renderToStaticMarkup(<InlineUsageBars limits={limits} isFetching={false} />)

    expect(markup).toContain('>32% used</span>')
    expect(markup).toContain('>Session now</span>')
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
    expect(markup).toContain('37% used wk')
  })

  it('shows remaining copy and remaining meter fill', async () => {
    mocks.usagePercentageDisplay = 'remaining'
    const { InlineUsageBars } = await import('./StatusBar')

    const markup = renderToStaticMarkup(
      <InlineUsageBars limits={claudeLimits()} isFetching={false} />
    )

    expect(markup).toContain('>68% left</span>')
    expect(markup).toContain('>5h</span>')
    expect(markup).toContain('>84% left</span>')
    expect(markup).toContain('>wk</span>')
    expect(markup).toContain('>58% left</span>')
    expect(markup).toContain('>Fable</span>')
    expect(markup).toContain('width:68%')
    expect(markup).toContain('width:84%')
    expect(markup).toContain('width:58%')
    expect(markup).not.toContain('width:32%')
  })
})
