import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type * as ReactModule from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { ProviderPanel } from './tooltip'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'error',
    ...overrides
  }
}

const PROVIDER_IDS: ProviderRateLimits['provider'][] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'zcode'
]

afterEach(() => {
  vi.useRealTimers()
})

describe('ProviderPanel pace', () => {
  const DAY_MS = 24 * 60 * 60_000

  function weeklyProvider(usedPercent: number, daysElapsed: number): ProviderRateLimits {
    return provider({
      status: 'ok',
      weekly: {
        usedPercent,
        windowMinutes: 10080,
        resetsAt: Date.now() + (7 - daysElapsed) * DAY_MS,
        resetDescription: null
      }
    })
  }

  it('reports reserve and marks the even-burn budget when usage trails it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: weeklyProvider(10, 2) }))

    expect(markup).toContain('data-usage-pace="reserve"')
    expect(markup).toContain('19% in reserve · Lasts until reset')
    expect(markup).toContain('bg-status-success')
    expect(markup).toContain('left:29%')
  })

  it('reports deficit with a run-out estimate when usage outruns the budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: weeklyProvider(60, 2) }))

    expect(markup).toContain('data-usage-pace="deficit"')
    expect(markup).toContain('31% in deficit · Runs out in 1d 8h')
    expect(markup).toContain('bg-destructive')
  })

  it('holds the line at on-pace inside the tolerance band', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: weeklyProvider(29, 2) }))

    expect(markup).toContain('data-usage-pace="on-pace"')
    // On pace still projects a run-out: an even burn lands on empty at the reset.
    expect(markup).toContain('On pace · Runs out in 4d 21h')
  })

  it('stays out of the panel while the window is too young to read', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: weeklyProvider(1, 0.1) }))

    expect(markup).not.toContain('data-usage-pace')
    expect(markup).not.toContain('in reserve')
    expect(markup).not.toContain('On pace')
  })

  it('stays out of the panel when the window carries no reset timestamp', () => {
    const p = provider({
      status: 'ok',
      weekly: {
        usedPercent: 40,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      }
    })

    expect(renderToStaticMarkup(createElement(ProviderPanel, { p }))).not.toContain(
      'data-usage-pace'
    )
  })

  it('mirrors the marker with the fill under remaining-percentage display', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))

    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: weeklyProvider(10, 2),
        usagePercentageDisplay: 'remaining'
      })
    )

    expect(markup).toContain('width:90%')
    expect(markup).toContain('left:71%')
    expect(markup).toContain('19% in reserve')
  })

  it("paces each window off its own clock rather than the provider's tightest", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      status: 'ok',
      session: {
        usedPercent: 6,
        windowMinutes: 300,
        resetsAt: Date.now() + 300 * 60_000 - 44 * 60_000,
        resetDescription: null
      },
      weekly: {
        usedPercent: 60,
        windowMinutes: 10080,
        resetsAt: Date.now() + 5 * DAY_MS,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('9% in reserve')
    expect(markup).toContain('31% in deficit')
  })

  it.each(PROVIDER_IDS)('paces %s off the same budget, with no per-provider gate', (providerId) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({ provider: providerId, status: 'ok', weekly: weeklyProvider(10, 2).weekly })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('data-usage-pace="reserve"')
    expect(markup).toContain('19% in reserve')
  })

  it('paces per-model buckets, not just the named session and weekly windows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'gemini',
      status: 'ok',
      buckets: [
        {
          name: 'Pro',
          usedPercent: 10,
          windowMinutes: 60,
          resetsAt: Date.now() + 45 * 60_000,
          resetDescription: null
        }
      ]
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    // A quarter into the hour against 10% spent leaves 15 points of headroom.
    expect(markup).toContain('15% in reserve')
  })
})
