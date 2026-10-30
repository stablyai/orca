// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageScanState
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint
} from '../../../../shared/codex-usage-types'
import UsageDashboardDrawerContent from './UsageDashboardDrawerContent'

const mocks = vi.hoisted(() => ({
  state: {
    rateLimits: {
      claude: null,
      codex: null,
      gemini: null,
      antigravity: null,
      opencodeGo: null,
      kimi: null,
      minimax: null,
      grok: null,
      cursor: null,
      zcode: null
    } as Record<string, unknown>,
    usagePercentageDisplay: 'used' as 'used' | 'remaining',
    fetchRateLimits: vi.fn(),
    refreshRateLimits: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/settings/SettingsFormControls', () => ({
  SettingsSegmentedControl: <T extends string | number>({
    value,
    onChange,
    options,
    ariaLabel
  }: {
    value: T
    onChange: (value: T) => void
    options: { value: T; label: string }[]
    ariaLabel: string
  }) => (
    <div role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}))

const enabledScanState: ClaudeUsageScanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: 1,
  lastScanCompletedAt: 2,
  lastScanError: null,
  hasAnyClaudeData: true
}
const disabledScanState: ClaudeUsageScanState = {
  ...enabledScanState,
  enabled: false,
  hasAnyClaudeData: false
}

// ast-grep-ignore: test-no-wall-clock-tsx -- the drawer zero-fills from the real local date, so fixture days must match it
function localDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const claudeDaily: ClaudeUsageDailyPoint[] = [
  {
    day: localDay(),
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 0
  }
]

function claudeBreakdown(costUsd: number | null): ClaudeUsageBreakdownRow[] {
  return [
    {
      key: 'claude-sonnet-4-5',
      label: 'claude-sonnet-4-5',
      sessions: 1,
      turns: 2,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
      estimatedCostUsd: costUsd
    }
  ]
}

type UsageApiMock = {
  getScanState: () => Promise<unknown>
  getDaily: (args: unknown) => Promise<unknown>
  getBreakdown: (args: unknown) => Promise<unknown>
}

function providerApi(
  scanState: unknown,
  daily: unknown[],
  breakdown: unknown[]
): { api: UsageApiMock; getDaily: ReturnType<typeof vi.fn> } {
  const getDaily = vi.fn(async () => daily)
  return {
    api: {
      getScanState: async () => scanState,
      getDaily,
      getBreakdown: async () => breakdown
    },
    getDaily
  }
}

function installApi(overrides: Record<string, unknown> = {}): ReturnType<typeof providerApi> {
  const claude = providerApi(enabledScanState, claudeDaily, claudeBreakdown(0.2))
  Object.assign(window, {
    api: {
      claudeUsage: claude.api,
      codexUsage: providerApi(disabledScanState, [], []).api,
      openCodeUsage: providerApi(disabledScanState, [], []).api,
      museUsage: providerApi(disabledScanState, [], []).api,
      ompUsage: providerApi(disabledScanState, [], []).api,
      ...overrides
    }
  })
  return claude
}

beforeEach(() => {
  for (const key of Object.keys(mocks.state.rateLimits)) {
    mocks.state.rateLimits[key] = null
  }
  mocks.state.usagePercentageDisplay = 'used'
  mocks.state.fetchRateLimits.mockClear()
  mocks.state.refreshRateLimits.mockClear()
  mocks.state.openSettingsTarget.mockClear()
  mocks.state.openSettingsPage.mockClear()
})

afterEach(cleanup)

describe('UsageDashboardDrawerContent', () => {
  it('fetches every enabled provider once and renders the chart, table and footer', async () => {
    const claude = installApi()
    render(<UsageDashboardDrawerContent />)

    await waitFor(() =>
      expect(claude.getDaily).toHaveBeenCalledWith({ scope: 'all', range: '30d' })
    )
    expect(claude.getDaily).toHaveBeenCalledTimes(1)
    expect(mocks.state.fetchRateLimits).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('usage-dashboard-daily-chart')).toBeInTheDocument()
    expect(screen.getByTestId('usage-dashboard-model-table')).toBeInTheDocument()
    // Claude's rows price the period, and the series sums input+output+cache.
    const footer = screen.getByTestId('usage-dashboard-footer')
    expect(within(footer).getByText('3.5k')).toBeInTheDocument()
    expect(within(footer).getByText('$0.20')).toBeInTheDocument()
    expect(within(footer).getByText('Last 14 days')).toBeInTheDocument()
    // The 14-day view reads 30-day provider buckets, so the cost must name its real window.
    expect(within(footer).getByText('Est. cost · 30d')).toBeInTheDocument()
  })

  it('skips disabled providers instead of fetching their data', async () => {
    const codex = providerApi(disabledScanState, [], [])
    const claude = installApi({ codexUsage: codex.api })
    render(<UsageDashboardDrawerContent />)

    await waitFor(() => expect(claude.getDaily).toHaveBeenCalled())
    expect(codex.getDaily).not.toHaveBeenCalled()
  })

  it('refetches with the 7-day range when the period changes', async () => {
    const claude = installApi()
    render(<UsageDashboardDrawerContent />)

    await waitFor(() => expect(claude.getDaily).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))

    await waitFor(() =>
      expect(claude.getDaily).toHaveBeenLastCalledWith({ scope: 'all', range: '7d' })
    )
    expect(screen.getByText('Last 7 days')).toBeInTheDocument()
    // A 7-day period reads a 7-day provider bucket, so the cost needs no window qualifier.
    expect(
      within(screen.getByTestId('usage-dashboard-footer')).getByText('Est. cost')
    ).toBeInTheDocument()
  })

  it('switches the fetch scope when the orca toggle is selected', async () => {
    const claude = installApi()
    render(<UsageDashboardDrawerContent />)

    await waitFor(() => expect(claude.getDaily).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Orca worktrees only' }))

    await waitFor(() =>
      expect(claude.getDaily).toHaveBeenLastCalledWith({ scope: 'orca', range: '30d' })
    )
  })

  it('renders an em dash for unpriced models instead of NaN', async () => {
    installApi({
      claudeUsage: providerApi(enabledScanState, claudeDaily, claudeBreakdown(null)).api
    })
    render(<UsageDashboardDrawerContent />)

    expect(await screen.findByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  it('normalizes Codex cached input out of the input column', async () => {
    const codexDaily: CodexUsageDailyPoint[] = [
      {
        day: localDay(),
        inputTokens: 2_000,
        cachedInputTokens: 800,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        totalTokens: 2_100
      }
    ]
    const codexBreakdown: CodexUsageBreakdownRow[] = [
      {
        key: 'gpt-6',
        label: 'gpt-6',
        sessions: 1,
        events: 1,
        inputTokens: 2_000,
        cachedInputTokens: 800,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        totalTokens: 2_100,
        estimatedCostUsd: 0.05,
        hasInferredPricing: false
      }
    ]
    installApi({
      codexUsage: providerApi(enabledScanState, codexDaily, codexBreakdown).api
    })
    render(<UsageDashboardDrawerContent />)

    const row = await screen.findByText('gpt-6')
    const cells = [...(row.closest('tr')?.querySelectorAll('td') ?? [])].map(
      (cell) => cell.textContent
    )
    expect(cells).toEqual(['Codex', 'gpt-6', '1.2k', '100', '800', '40', '$0.05'])
  })

  it('refreshes provider data and rate limits from the refresh button', async () => {
    const claude = installApi()
    render(<UsageDashboardDrawerContent />)

    await waitFor(() => expect(claude.getDaily).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage data' }))

    expect(mocks.state.refreshRateLimits).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(claude.getDaily).toHaveBeenCalledTimes(2))
  })

  it('deep-links to the stats pane from the footer button', async () => {
    installApi()
    render(<UsageDashboardDrawerContent />)
    await waitFor(() => expect(screen.getByTestId('usage-dashboard-footer')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Open full stats' }))

    expect(mocks.state.openSettingsTarget).toHaveBeenCalledWith({ pane: 'stats', repoId: null })
    expect(mocks.state.openSettingsPage).toHaveBeenCalledTimes(1)
  })

  it('shows the empty placeholder when no provider is enabled', async () => {
    Object.assign(window, {
      api: {
        claudeUsage: providerApi(disabledScanState, [], []).api,
        codexUsage: providerApi(disabledScanState, [], []).api,
        openCodeUsage: providerApi(disabledScanState, [], []).api,
        museUsage: providerApi(disabledScanState, [], []).api,
        ompUsage: providerApi(disabledScanState, [], []).api
      }
    })
    render(<UsageDashboardDrawerContent />)

    expect(
      await screen.findByText(
        'No local usage found yet. Enable a usage provider in Settings → Stats & Usage.'
      )
    ).toBeInTheDocument()
  })

  it('renders quota rows from the rateLimits slice', async () => {
    installApi()
    mocks.state.rateLimits.claude = {
      provider: 'claude',
      session: {
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    const view = render(<UsageDashboardDrawerContent />)

    await waitFor(() =>
      expect(view.container.querySelector('[data-quota-provider="claude"]')).not.toBeNull()
    )
    expect(
      view.container.querySelector('[data-quota-provider="claude"] [data-usage-window="Session"]')
    ).not.toBeNull()
  })
})
