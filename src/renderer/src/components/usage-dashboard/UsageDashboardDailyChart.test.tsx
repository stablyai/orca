// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageDashboardDailyPoint } from './usage-dashboard-series'
import UsageDashboardDailyChart from './UsageDashboardDailyChart'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  getIntlLocale: () => 'en'
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

function point(
  day: string,
  values: Partial<Omit<UsageDashboardDailyPoint, 'day'>> = {}
): UsageDashboardDailyPoint {
  return {
    day,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...values
  }
}

afterEach(cleanup)

describe('UsageDashboardDailyChart', () => {
  it('renders one column per day with the three stacked segments', () => {
    const view = render(
      <UsageDashboardDailyChart
        points={[
          point('2026-05-13'),
          point('2026-05-14', {
            inputTokens: 1_000,
            cacheReadTokens: 250,
            cacheWriteTokens: 150,
            outputTokens: 600
          }),
          point('2026-05-15')
        ]}
      />
    )

    expect(view.container.querySelectorAll('[data-chart-day]')).toHaveLength(3)
    const segments = view.container.querySelectorAll('[data-chart-segment]')
    expect([...segments].map((node) => node.getAttribute('data-chart-segment'))).toEqual([
      'empty',
      'output',
      'cached',
      'input',
      'empty'
    ])
    // Cached folds cache reads and writes into one segment; legend names every series.
    expect(screen.getByText('Cached')).toBeInTheDocument()
    // The y-axis scale replaces per-column value labels, which collided in dense windows.
    expect(view.container.textContent).toContain('1.0k')
    // Date labels thin out so nothing renders clipped: first and last days stay labeled.
    expect(screen.getByText('May 13')).toBeInTheDocument()
    expect(screen.getByText('May 15')).toBeInTheDocument()
  })
  it('shows reasoning tokens in the tooltip detail when the day reports them', () => {
    render(
      <UsageDashboardDailyChart
        points={[
          point('2026-05-14', {
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 500,
            costUsd: 0.25
          })
        ]}
      />
    )

    expect(screen.getAllByText('Reasoning: 500 tokens').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Est. cost: $0.25').length).toBeGreaterThan(0)
  })

  it('omits the reasoning line for days without reasoning tokens', () => {
    render(<UsageDashboardDailyChart points={[point('2026-05-14', { inputTokens: 10 })]} />)

    expect(screen.queryByText(/Reasoning:/)).toBeNull()
  })

  it('renders a muted placeholder when the window has no tokens', () => {
    const view = render(
      <UsageDashboardDailyChart points={[point('2026-05-14'), point('2026-05-15')]} />
    )

    expect(screen.getByText('No token usage in this period yet.')).toBeInTheDocument()
    expect(view.container.querySelectorAll('[data-chart-day]')).toHaveLength(0)
  })
})
