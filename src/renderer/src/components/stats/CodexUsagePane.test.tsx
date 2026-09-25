// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexUsageSummary } from '../../../../shared/codex-usage-types'
import type { AppState } from '../../store'
import { CodexUsagePane } from './CodexUsagePane'

const noop = vi.fn()

let currentSummary: CodexUsageSummary | null = null

const mockStoreState = {
  codexUsageScanState: {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 1,
    lastScanCompletedAt: 2,
    lastScanError: null,
    hasAnyCodexData: true
  },
  get codexUsageSummary() {
    return currentSummary
  },
  codexUsageDaily: [],
  codexUsageModelBreakdown: [],
  codexUsageProjectBreakdown: [],
  codexUsageRecentSessions: [],
  codexUsageScope: 'orca',
  codexUsageRange: '30d',
  fetchCodexUsage: noop,
  setCodexUsageEnabled: noop,
  refreshCodexUsage: noop,
  setCodexUsageScope: noop,
  setCodexUsageRange: noop,
  recordFeatureInteraction: noop
} satisfies Partial<AppState>

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mockStoreState)
}))

vi.mock('./CodexUsageDetails', () => ({
  CodexUsageDetails: () => <div>details</div>
}))

vi.mock('./ShareUsageButton', () => ({
  ShareUsageButton: () => <button type="button">Share</button>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function summaryWithUnpriced(
  hasUnpricedModels: boolean,
  estimatedCostUsd: number | null = 12.5
): CodexUsageSummary {
  return {
    scope: 'orca',
    range: '30d',
    sessions: 1,
    events: 1,
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 250,
    reasoningOutputTokens: 100,
    totalTokens: 1250,
    estimatedCostUsd,
    hasUnpricedModels,
    topModel: 'gpt-6-astra',
    topProject: 'Repo',
    hasAnyCodexData: true
  }
}

afterEach(() => {
  currentSummary = null
  cleanup()
})

describe('CodexUsagePane estimated cost card', () => {
  it('qualifies the total when a named model has no pricing entry', () => {
    currentSummary = summaryWithUnpriced(true)

    render(<CodexUsagePane />)

    expect(
      screen.getByText('Est. API-equivalent cost • excludes unpriced models')
    ).toBeInTheDocument()
    expect(screen.getByText('$12.50')).toBeInTheDocument()
  })

  it('drops the caveat when no model was priced, since there is no remainder to exclude', () => {
    currentSummary = summaryWithUnpriced(true, null)

    render(<CodexUsagePane />)

    expect(screen.getByText('Est. API-equivalent cost')).toBeInTheDocument()
    expect(screen.queryByText(/excludes unpriced models/)).not.toBeInTheDocument()
    expect(screen.getByText('n/a')).toBeInTheDocument()
  })

  it('leaves the total unqualified when every model is priced', () => {
    currentSummary = summaryWithUnpriced(false)

    render(<CodexUsagePane />)

    expect(screen.getByText('Est. API-equivalent cost')).toBeInTheDocument()
    expect(screen.queryByText(/excludes unpriced models/)).not.toBeInTheDocument()
  })
})
