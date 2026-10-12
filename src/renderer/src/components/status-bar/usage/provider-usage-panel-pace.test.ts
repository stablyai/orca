import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { ProviderPanel } from './provider-usage-panel'

const DAY_MS = 24 * 60 * 60_000

function renderWeekly(
  usedPercent: number,
  daysElapsed: number,
  usagePercentageDisplay: UsagePercentageDisplay = 'used'
): string {
  const p: ProviderRateLimits = {
    provider: 'claude',
    session: null,
    weekly: {
      usedPercent,
      windowMinutes: 10080,
      resetsAt: Date.now() + (7 - daysElapsed) * DAY_MS,
      resetDescription: null
    },
    updatedAt: 0,
    error: null,
    status: 'ok'
  }
  return renderToStaticMarkup(createElement(ProviderPanel, { p, usagePercentageDisplay }))
}

describe('ProviderPanel pace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports reserve and ticks the even-burn budget when usage trails it', () => {
    const markup = renderWeekly(10, 2)

    expect(markup).toContain('19% in reserve · Lasts until reset')
    expect(markup).toContain('left:29%')
  })

  it('reports deficit with a run-out estimate when usage outruns the budget', () => {
    expect(renderWeekly(60, 2)).toContain('31% in deficit · Runs out in 1d 8h')
  })

  it('mirrors the tick with the fill under remaining-percentage display', () => {
    const markup = renderWeekly(10, 2, 'remaining')

    expect(markup).toContain('width:90%')
    expect(markup).toContain('left:71%')
  })
})
