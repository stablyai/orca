// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageDashboardModelRow } from './usage-dashboard-series'
import UsageDashboardModelTable from './UsageDashboardModelTable'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  getIntlLocale: () => 'en'
}))

function row(overrides: Partial<UsageDashboardModelRow>): UsageDashboardModelRow {
  return {
    provider: 'claude',
    model: 'model-a',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1_500,
    costUsd: 0.2,
    ...overrides
  }
}

afterEach(cleanup)

describe('UsageDashboardModelTable', () => {
  it('renders rows in the given total-token order with provider labels and costs', () => {
    const view = render(
      <UsageDashboardModelTable
        rangeDays={30}
        rows={[
          row({ provider: 'omp', model: 'gpt-5.4', totalTokens: 5_000, costUsd: 1.5 }),
          row({ provider: 'claude', model: 'claude-sonnet-4-5', totalTokens: 3_600 }),
          row({ provider: 'muse', model: 'muse-spark', totalTokens: 75, costUsd: null })
        ]}
      />
    )

    expect(
      [...view.container.querySelectorAll('[data-model-row]')].map((node) =>
        node.getAttribute('data-model-row')
      )
    ).toEqual(['gpt-5.4', 'claude-sonnet-4-5', 'muse-spark'])
    expect(screen.getByText('omp')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Muse')).toBeInTheDocument()
    expect(screen.getByText('$1.50')).toBeInTheDocument()
    expect(screen.getByText('$0.20')).toBeInTheDocument()
    // Null cost renders an em dash, never NaN.
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(
      screen.getByText('Tokens and estimated cost by model in the last 30 days.')
    ).toBeInTheDocument()
  })

  it('shows the reasoning column only when a row reports reasoning tokens', () => {
    const withoutReasoning = render(<UsageDashboardModelTable rangeDays={7} rows={[row({})]} />)
    expect(screen.queryByText('Reasoning')).toBeNull()
    withoutReasoning.unmount()

    render(
      <UsageDashboardModelTable
        rangeDays={7}
        rows={[row({ provider: 'omp', model: 'gpt-5.4', reasoningTokens: 250 })]}
      />
    )
    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.getByText('250')).toBeInTheDocument()
  })

  it('renders the empty placeholder when no model usage is in range', () => {
    render(<UsageDashboardModelTable rangeDays={14} rows={[]} />)

    expect(screen.getByText('No model usage in this period yet.')).toBeInTheDocument()
  })
})
