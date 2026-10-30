// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpUsageSummary } from '../../../../shared/omp-usage-types'
import type { AppState } from '../../store'
import { OmpUsagePane } from './OmpUsagePane'

const noop = vi.fn()

const summary: OmpUsageSummary = {
  scope: 'all',
  range: '30d',
  sessions: 2,
  inputTokens: 1_000,
  cacheReadTokens: 200,
  cacheWriteTokens: 0,
  outputTokens: 300,
  reasoningTokens: 40,
  totalTokens: 1_500,
  costUsd: 1.25,
  topModel: 'gpt-5.4',
  topProject: 'orca',
  hasAnyOmpData: true
}

const mockStoreState = {
  ompUsageScanState: {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 1,
    lastScanCompletedAt: 2,
    lastScanError: null,
    hasAnyOmpData: true
  },
  ompUsageSummary: summary,
  ompUsageDaily: [
    {
      day: '2026-05-14',
      inputTokens: 1_000,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 300,
      reasoningTokens: 40,
      totalTokens: 1_500,
      costUsd: 1.25
    }
  ],
  ompUsageModelBreakdown: [],
  ompUsageProjectBreakdown: [],
  ompUsageRecentSessions: [],
  ompUsageScope: 'all',
  ompUsageRange: '30d',
  fetchOmpUsage: noop,
  setOmpUsageEnabled: noop,
  refreshOmpUsage: noop,
  setOmpUsageScope: noop,
  setOmpUsageRange: noop,
  recordFeatureInteraction: noop
} satisfies Partial<AppState>

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mockStoreState)
}))

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string) => fallback
}))

const chart = vi.hoisted(() => ({ daily: [] as { reasoningOutputTokens: number }[] }))

vi.mock('./CodexUsageDailyChart', () => ({
  CodexUsageDailyChart: ({ daily }: { daily: { reasoningOutputTokens: number }[] }) => {
    chart.daily = daily
    return <div data-testid="daily-chart" />
  }
}))

afterEach(cleanup)

describe('OmpUsagePane', () => {
  it('keeps reasoning out of the stacked chart while the cards still report it', () => {
    render(<OmpUsagePane />)

    // Resolution 8: reasoning is a table/caption figure, never a fourth stacked segment.
    expect(chart.daily).toHaveLength(1)
    expect(chart.daily[0].reasoningOutputTokens).toBe(0)
    expect(screen.getByText('Reasoning output')).toBeInTheDocument()
    expect(screen.getByText('40')).toBeInTheDocument()
  })
})
