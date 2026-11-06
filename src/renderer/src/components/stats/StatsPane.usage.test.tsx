// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import type { AppState } from '../../store'
import type { UsageHistorySource } from './use-usage-history'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { StatsPane } from './StatsPane'

const noop = vi.fn(async () => {})
const quota = {
  ...createEmptyRateLimitState(),
  codex: {
    provider: 'codex' as const,
    session: {
      usedPercent: 27,
      windowMinutes: 300,
      resetsAt: new Date(2026, 9, 24, 16).getTime(),
      resetDescription: null
    },
    weekly: { usedPercent: 55, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    planType: 'plus',
    updatedAt: new Date(2026, 9, 24, 11).getTime(),
    status: 'error' as const,
    error: 'Fixture network failure',
    usageMetadata: { failureKind: 'network' as const }
  }
}
const store = {
  statsSummary: {
    totalAgentsSpawned: 8,
    totalAgentTimeMs: 22 * 60_000,
    totalPRsCreated: 15,
    firstEventAt: new Date(2026, 0, 1).getTime()
  },
  fetchStatsSummary: noop,
  recordFeatureInteraction: noop,
  rateLimits: quota,
  fetchRateLimits: noop,
  refreshRateLimits: noop,
  openSettingsPage: noop,
  openSettingsTarget: noop
} satisfies Partial<AppState>
let sources: UsageHistorySource[] = []
let historyAccounts: ProviderAccountsSnapshot | null = null

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(store)
}))
vi.mock('../status-bar/use-owner-usage-rate-limits', () => ({
  useOwnerUsageRateLimits: () => ({
    rateLimits: quota,
    remoteOwner: { environmentId: 'remote', label: 'Build server' },
    refreshRemote: noop
  }),
  getUsageOwnerHostScope: () => ({ kind: 'environment', environmentId: 'remote' })
}))
vi.mock('./use-usage-history', () => ({
  useUsageHistory: () => ({
    sources,
    accounts: historyAccounts,
    isRefreshing: false,
    refresh: noop,
    enable: noop
  })
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span />,
  getAgentLabel: (agent: string) =>
    ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', muse: 'Muse' })[agent] ?? agent
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, params: Record<string, unknown> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? ''))
}))

function usage(patch: Partial<UsageHistoryRow>): UsageHistoryRow {
  return {
    provider: 'codex',
    day: '2026-10-24',
    sessionId: 'session-a',
    model: 'gpt-5.4',
    projectKey: 'folder',
    projectLabel: 'Folder project',
    inOrca: true,
    newInputTokens: 100,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    outputTokens: 200,
    reasoningTokens: 150,
    activityCount: 1,
    totalTokens: 1200,
    apiEquivalentCostUsd: 0.01,
    ...patch
  }
}

beforeEach(() => {
  historyAccounts = null
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 24, 12))
  sources = [
    {
      provider: 'codex',
      status: 'ready',
      enabled: true,
      isScanning: false,
      lastScanCompletedAt: new Date(2026, 9, 24, 10).getTime(),
      error: 'Fixture scan failed',
      rows: [
        usage({}),
        usage({ day: '2026-10-01', sessionId: 'session-old' }),
        usage({ sessionId: 'session-b', projectKey: 'other', projectLabel: 'Other project' })
      ]
    }
  ]
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Stats & Usage daily workflow', () => {
  it('switches chart units without treating missing prices as zero', () => {
    sources[0].rows = [
      usage({ apiEquivalentCostUsd: 0 }),
      usage({ day: '2026-10-23', sessionId: 'unpriced', apiEquivalentCostUsd: null }),
      usage({ day: '2026-10-22', sessionId: 'priced', apiEquivalentCostUsd: 0.02 }),
      usage({ day: '2026-10-22', sessionId: 'partly-unpriced', apiEquivalentCostUsd: null })
    ]
    render(<StatsPane />)
    const chart = screen.getByTestId('usage-history-daily')
    expect(within(chart).getAllByRole('button')).toHaveLength(30)
    fireEvent.click(within(chart).getByRole('radio', { name: 'API estimate' }))
    expect(within(chart).getAllByRole('button')).toHaveLength(30)
    expect(
      within(chart).getByRole('button', { name: '2026-10-21: $0.0000 API-equivalent estimate' })
    ).toBeEnabled()
    expect(
      within(chart).getByRole('button', { name: '2026-10-24: $0.0000 API-equivalent estimate' })
    ).toBeInTheDocument()
    const partialDay = within(chart).getByRole('button', {
      name: '2026-10-22: $0.02 * API-equivalent estimate'
    })
    expect(within(chart).getByRole('status')).toHaveTextContent('priced portion')
    expect(
      within(chart).getByRole('button', { name: '2026-10-23: n/a API-equivalent estimate' })
    ).toBeEnabled()
    fireEvent.click(partialDay)
    expect(within(chart).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTestId('usage-history-totals')).toHaveTextContent('$0.02')
  })

  it('keeps account-filtered totals, chart and expanded session detail coherent across an active-account switch', () => {
    const account = (id: string, email: string) => ({
      id,
      email,
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 3
    })
    historyAccounts = {
      claude: { accounts: [], activeAccountId: null },
      codex: {
        accounts: [
          account('work', 'work@example.test'),
          account('personal', 'personal@example.test')
        ],
        activeAccountId: 'personal'
      },
      rateLimits: null
    }
    sources = sources.map((source) => ({
      ...source,
      rows: [
        usage({ accountId: 'work', sessionId: 'work-session' }),
        usage({ accountId: 'personal', sessionId: 'personal-session', day: '2026-10-23' }),
        usage({ sessionId: 'legacy-session' })
      ]
    }))
    const view = render(<StatsPane />)
    expect(screen.getByTestId('usage-history-account-coverage')).toHaveTextContent('1,200 tokens')
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }))
    fireEvent.click(screen.getByRole('option', { name: 'Codex · work@example.test' }))
    expect(within(screen.getByTestId('usage-history-totals')).getByText('1.2k')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-history-daily')).getAllByRole('button')).toHaveLength(
      30
    )
    const table = screen.getByRole('table')
    expect(table).toHaveTextContent('work@example.test')
    expect(table).not.toHaveTextContent('personal@example.test')
    fireEvent.click(within(table).getByRole('button', { name: '2026-10-24' }))
    expect(table).toHaveTextContent('work-session')
    expect(table).not.toHaveTextContent('legacy-session')
    historyAccounts = {
      ...historyAccounts,
      codex: { ...historyAccounts.codex, activeAccountId: 'work' }
    }
    view.rerender(<StatsPane />)
    expect(within(screen.getByTestId('usage-history-totals')).getByText('1.2k')).toBeInTheDocument()
    expect(screen.getByTestId('usage-history-account-coverage')).toHaveTextContent('1,200 tokens')
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }))
    fireEvent.click(screen.getByRole('option', { name: 'Unknown account' }))
    expect(screen.getByRole('table')).not.toHaveTextContent('work@example.test')
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '2026-10-24' }))
    expect(screen.getByRole('table')).toHaveTextContent('legacy-session')
  })
  it('keeps historical totals, filters and drilldown coherent', () => {
    render(<StatsPane />)
    expect(screen.getByText('Build server · Recorded agent logs')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-history-totals')).getByText('3.6k')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }))
    expect(within(screen.getByTestId('usage-history-totals')).getByText('2.4k')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }))
    fireEvent.click(screen.getByRole('option', { name: 'Folder project' }))
    expect(within(screen.getByTestId('usage-history-totals')).getByText('1.2k')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-history-daily')).getAllByRole('button')).toHaveLength(7)
    expect(screen.queryByText('Other project')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2026-10-24' }))
    expect(screen.getByText('session-a', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('API-equivalent estimate: $0.01')).toBeInTheDocument()
    expect(screen.getByText('Fixture scan failed')).toBeInTheDocument()
    const activity = screen.getByText('Local Orca activity · since first launch').closest('details')
    expect(activity).not.toHaveAttribute('open')
  })

  it('shows unavailable history as unavailable and never substitutes zero-token totals', () => {
    sources = [
      {
        provider: 'codex',
        status: 'unsupported',
        enabled: false,
        isScanning: false,
        lastScanCompletedAt: null,
        error: null,
        rows: []
      }
    ]
    render(<StatsPane />)
    expect(screen.getByText('History unavailable on this host')).toBeInTheDocument()
    expect(
      screen.getByText(/Historical usage is unavailable from Build server/)
    ).toBeInTheDocument()
    const tokens = within(screen.getByTestId('usage-history-totals')).getByText('Tokens')
    expect(tokens.previousElementSibling).toHaveTextContent(/^—$/)
    expect(screen.queryByRole('button', { name: 'Enable Codex' })).not.toBeInTheDocument()
  })

  it('makes day selection update every historical projection and provides a clear reset', () => {
    sources = sources.map((source) => ({
      ...source,
      error: null,
      rows: [usage({}), usage({ day: '2026-10-23', sessionId: 'session-b' })]
    }))
    render(<StatsPane />)
    fireEvent.click(
      within(screen.getByTestId('usage-history-daily')).getByRole('button', {
        name: '2026-10-23: 1,200 tokens'
      })
    )
    expect(within(screen.getByTestId('usage-history-totals')).getByText('1.2k')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-history-daily')).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '2026-10-24' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2026-10-23 · Clear day filter' }))
    expect(within(screen.getByTestId('usage-history-totals')).getByText('2.4k')).toBeInTheDocument()
  })
})
