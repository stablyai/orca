// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import { UsageOverviewPane } from './UsageOverviewPane'

const noop = vi.fn()
const state = {
  claudeUsageScanState: null,
  claudeUsageSummary: null,
  claudeUsageDaily: [],
  codexUsageScanState: {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 1,
    lastScanCompletedAt: 2,
    lastScanError: null,
    hasAnyCodexData: true
  },
  codexUsageSummary: null,
  codexUsageDaily: [],
  openCodeUsageScanState: null,
  openCodeUsageSummary: null,
  openCodeUsageDaily: [],
  museUsageScanState: null,
  museUsageSummary: null,
  museUsageDaily: [],
  fetchClaudeUsage: noop,
  fetchCodexUsage: noop,
  fetchOpenCodeUsage: noop,
  fetchMuseUsage: noop,
  refreshClaudeUsage: noop,
  refreshCodexUsage: noop,
  refreshOpenCodeUsage: noop,
  refreshMuseUsage: noop,
  enableClaudeUsage: noop,
  enableCodexUsage: noop,
  enableOpenCodeUsage: noop,
  enableMuseUsage: noop,
  recordFeatureInteraction: noop
} satisfies Partial<AppState>

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(state)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../hooks/use-now', () => ({ useNow: () => new Date(2026, 9, 16, 12).getTime() }))

afterEach(cleanup)

it('updates the overview cards and heatmap through the visible range picker', async () => {
  const getSnapshot = vi.fn(async ({ range }: { range: string }) => {
    const tokens = range === 'today' ? 100 : range === '7d' ? 700 : 3000
    return {
      scanState: state.codexUsageScanState,
      summary: {
        scope: 'orca',
        range,
        sessions: 1,
        events: 2,
        inputTokens: tokens - 10,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: tokens,
        estimatedCostUsd: tokens / 100,
        hasUnpricedModels: false,
        topModel: 'test-model',
        topProject: 'test-project',
        hasAnyCodexData: true
      },
      daily: [{ day: '2026-10-16', totalTokens: tokens }]
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexUsage: { getSnapshot } }
  })
  render(
    <TooltipProvider>
      <UsageOverviewPane />
    </TooltipProvider>
  )
  await screen.findByText('3.0k')
  expect(screen.getAllByText('$30.00')).toHaveLength(2)
  expect(screen.getByLabelText('Recent token activity heatmap').children).toHaveLength(30)

  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Usage time range' }))
  await user.click(screen.getByRole('option', { name: 'Today' }))
  await waitFor(() => expect(screen.getAllByText('$1.00')).toHaveLength(2))
  expect(screen.queryAllByText('$30.00')).toHaveLength(0)
  expect(screen.getByLabelText('Recent token activity heatmap').children).toHaveLength(1)

  await user.click(screen.getByRole('combobox', { name: 'Usage time range' }))
  await user.click(screen.getByRole('option', { name: 'Last 7 days' }))
  await screen.findAllByText('$7.00')
  expect(screen.getByLabelText('Recent token activity heatmap').children).toHaveLength(7)
})
