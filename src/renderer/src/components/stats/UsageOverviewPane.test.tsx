// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageScanState,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type {
  OmpUsageDailyPoint,
  OmpUsageScanState,
  OmpUsageSummary
} from '../../../../shared/omp-usage-types'
import { UsageOverviewPane } from './UsageOverviewPane'

const mocks = vi.hoisted(() => {
  return {
    state: {
      claudeUsageScanState: null as ClaudeUsageScanState | null,
      claudeUsageSummary: null as ClaudeUsageSummary | null,
      claudeUsageDaily: [] as ClaudeUsageDailyPoint[],
      codexUsageScanState: null,
      codexUsageSummary: null,
      codexUsageDaily: [],
      openCodeUsageScanState: null,
      openCodeUsageSummary: null,
      openCodeUsageDaily: [],
      museUsageScanState: null,
      museUsageSummary: null,
      museUsageDaily: [],
      ompUsageScanState: null as OmpUsageScanState | null,
      ompUsageSummary: null as OmpUsageSummary | null,
      ompUsageDaily: [] as OmpUsageDailyPoint[],
      fetchClaudeUsage: vi.fn(),
      fetchCodexUsage: vi.fn(),
      fetchOpenCodeUsage: vi.fn(),
      fetchMuseUsage: vi.fn(),
      fetchOmpUsage: vi.fn(),
      refreshClaudeUsage: vi.fn(),
      refreshCodexUsage: vi.fn(),
      refreshOpenCodeUsage: vi.fn(),
      refreshMuseUsage: vi.fn(),
      refreshOmpUsage: vi.fn(),
      enableClaudeUsage: vi.fn(),
      enableCodexUsage: vi.fn(),
      enableOpenCodeUsage: vi.fn(),
      enableMuseUsage: vi.fn(),
      recordFeatureInteraction: vi.fn()
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// ast-grep-ignore: test-no-wall-clock-tsx -- the overview heatmap always ends on the real local today, so the omp fixture day must match it
function localDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const enabledClaudeScanState: ClaudeUsageScanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: 1,
  lastScanCompletedAt: 2,
  lastScanError: null,
  hasAnyClaudeData: true
}

const claudeSummary: ClaudeUsageSummary = {
  scope: 'orca',
  range: '30d',
  sessions: 1,
  turns: 2,
  zeroCacheReadTurns: 0,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheReuseRate: 0,
  estimatedCostUsd: 0.01,
  hasUnpricedModels: false,
  topModel: 'claude-sonnet-4-5',
  topProject: 'orca',
  hasAnyClaudeData: true
}

const ompScanState: OmpUsageScanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: 3,
  lastScanCompletedAt: 4,
  lastScanError: null,
  hasAnyOmpData: true
}

const ompSummary: OmpUsageSummary = {
  scope: 'all',
  range: '30d',
  sessions: 1,
  inputTokens: 10,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  outputTokens: 5,
  reasoningTokens: 0,
  totalTokens: 18,
  costUsd: 0.2,
  topModel: 'gpt-5.4',
  topProject: 'orca',
  hasAnyOmpData: true
}

function resetState(): void {
  mocks.state.claudeUsageScanState = enabledClaudeScanState
  mocks.state.claudeUsageSummary = claudeSummary
  mocks.state.codexUsageScanState = null
  mocks.state.codexUsageSummary = null
  mocks.state.openCodeUsageScanState = null
  mocks.state.openCodeUsageSummary = null
  mocks.state.museUsageScanState = null
  mocks.state.museUsageSummary = null
  mocks.state.ompUsageScanState = ompScanState
  mocks.state.ompUsageSummary = ompSummary
  mocks.state.ompUsageDaily = [
    {
      day: localDay(),
      inputTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 18,
      costUsd: 0.2
    }
  ]
}

afterEach(cleanup)

describe('UsageOverviewPane', () => {
  it('feeds omp daily totals into the combined intensity grid', () => {
    resetState()
    render(<UsageOverviewPane />)

    // 18 tokens only appears when the merged series carries omp's daily point.
    expect(screen.getByLabelText(`${localDay()}: 18 tokens`)).toBeInTheDocument()
    expect(mocks.state.fetchOmpUsage).toHaveBeenCalledTimes(1)
  })
})
