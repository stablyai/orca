// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { CodexManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { UsageAccountQuotas, UsageAccountQuotaCard } from './UsageAccountQuotas'
import { buildUsageAccountQuotaRows } from './usage-account-quota-rows'

vi.mock('../../store', () => ({ useAppStore: () => vi.fn() }))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span />,
  getAgentLabel: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values: Record<string, unknown> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key] ?? ''))
}))

function account(id: string, workspaceLabel: string): CodexManagedAccountSummary {
  return {
    id,
    workspaceLabel,
    email: 'same@example.test',
    managedHomeRuntime: 'host',
    createdAt: 1,
    updatedAt: 2,
    lastAuthenticatedAt: 3
  }
}

function quota(percent: number, planType: string): ProviderRateLimits {
  return {
    provider: 'codex',
    planType,
    status: 'ok',
    error: null,
    updatedAt: 200,
    session: { usedPercent: percent, windowMinutes: 300, resetsAt: 500000, resetDescription: null },
    weekly: {
      usedPercent: percent + 10,
      windowMinutes: 10080,
      resetsAt: 900000,
      resetDescription: null
    }
  }
}

function fixture() {
  const accounts: ProviderAccountsSnapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        account('work', 'Work'),
        account('personal', 'Personal'),
        account('unavailable', 'Unavailable')
      ],
      activeAccountId: 'work'
    },
    rateLimits: null
  }
  const rateLimits = createEmptyRateLimitState({
    codex: quota(27, 'business'),
    inactiveCodexAccounts: [
      { accountId: 'personal', rateLimits: quota(65, 'plus'), updatedAt: 200, isFetching: false },
      {
        accountId: 'unavailable',
        rateLimits: {
          ...quota(0, 'plus'),
          session: null,
          weekly: null,
          status: 'error',
          error: 'Fixture account unavailable',
          usageMetadata: { failureKind: 'network' }
        },
        updatedAt: 200,
        isFetching: false
      }
    ]
  })
  return { accounts, rateLimits }
}

afterEach(cleanup)

describe('account quota coverage', () => {
  it('omits unconfigured current providers and preserves configured unavailable and failing accounts', () => {
    const unavailable = (provider: ProviderRateLimits['provider']): ProviderRateLimits => ({
      ...quota(0, 'plus'),
      provider,
      session: null,
      weekly: null,
      status: 'unavailable',
      error: 'Not configured'
    })
    const limits = createEmptyRateLimitState({
      gemini: unavailable('gemini'),
      opencodeGo: unavailable('opencode-go'),
      kimi: unavailable('kimi'),
      grok: unavailable('grok'),
      cursor: {
        ...unavailable('cursor'),
        status: 'error',
        error: 'Token expired',
        usageMetadata: { failureKind: 'stale-token' }
      },
      minimax: unavailable('minimax'),
      minimaxApiKeyConfigured: true
    })
    expect(buildUsageAccountQuotaRows(limits, null).map((row) => row.provider.provider)).toEqual([
      'minimax',
      'cursor'
    ])
    expect(
      buildUsageAccountQuotaRows(limits, null, false, { geminiCliOAuthEnabled: true }).map(
        (row) => row.provider.provider
      )
    ).toEqual(['gemini', 'minimax', 'cursor'])
    render(
      <UsageAccountQuotas
        rateLimits={limits}
        ownerLabel="This device"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    )
    expect(screen.queryByTestId('usage-quota-gemini')).not.toBeInTheDocument()
    expect(screen.getByTestId('usage-quota-cursor')).toHaveTextContent('Run cursor-agent login')
    expect(screen.getByRole('button', { name: 'Manage accounts' })).toBeInTheDocument()
  })

  it('shows each reported account with distinct safe identity, plan, windows, resets and source errors', () => {
    const { accounts, rateLimits } = fixture()
    render(
      <UsageAccountQuotas
        accounts={accounts}
        rateLimits={rateLimits}
        ownerLabel="Build server"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    )
    const cards = screen.getAllByTestId('usage-quota-codex')
    expect(cards).toHaveLength(3)
    expect(cards[0]).toHaveTextContent('same@example.test (Work)')
    expect(cards[0]).toHaveTextContent('Business')
    expect(cards[0]).toHaveTextContent('27% used')
    expect(cards[0]).toHaveTextContent('37% used')
    expect(cards[0]).toHaveTextContent('5h')
    expect(cards[0]).toHaveTextContent('Resets')
    expect(cards[1]).toHaveTextContent('same@example.test (Personal)')
    expect(cards[1]).toHaveTextContent('Plus')
    expect(cards[1]).toHaveTextContent('65% used')
    expect(cards[1]).toHaveTextContent('75% used')
    expect(within(cards[2]).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(cards[2]).toHaveTextContent('Fixture account unavailable')
    expect(cards[2]).toHaveTextContent('Quota data unavailable')
    expect(cards[2]).not.toHaveTextContent('Last known quota')
    expect(screen.getByTestId('usage-quota-coverage')).toHaveTextContent(
      'Other providers show the current account only'
    )
  })

  it('warns about incomplete coverage when retained local accounts cannot be verified', () => {
    const { accounts, rateLimits } = fixture()
    render(
      <UsageAccountQuotas
        accounts={accounts}
        accountsUnverifiable
        rateLimits={rateLimits}
        ownerLabel="This device"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    )
    expect(screen.getByTestId('usage-quota-coverage')).toHaveTextContent(
      'The account list is unavailable or incomplete.'
    )
    expect(screen.getAllByTestId('usage-quota-codex')).toHaveLength(3)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })

  it('labels managed Claude and Codex accounts with their remote owner', () => {
    const { accounts, rateLimits } = fixture()
    rateLimits.claude = { ...quota(18, 'max'), provider: 'claude' }
    accounts.claude.systemDefaultEmail = 'claude@example.test'
    render(
      <UsageAccountQuotas
        accounts={accounts}
        rateLimits={rateLimits}
        ownerLabel="Build server"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    )
    const cards = [
      screen.getByTestId('usage-quota-claude'),
      ...screen.getAllByTestId('usage-quota-codex')
    ]
    for (const card of cards) {
      expect(card).toHaveTextContent('Build server')
      expect(card).not.toHaveTextContent('This device')
    }
  })

  it('labels retained quota windows after a failed refresh', () => {
    render(<UsageAccountQuotaCard provider={{ ...quota(27, 'plus'), status: 'error' }} />)
    expect(screen.getByText('Last known quota; the latest check failed.')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('never assigns host-selected account windows to a different runtime and keeps unknown rows unavailable', () => {
    const { accounts, rateLimits } = fixture()
    accounts.codex.accounts.push({
      ...account('wsl', 'Linux'),
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    accounts.codex.activeAccountIdsByRuntime = { host: 'work', wsl: { Ubuntu: 'wsl' } }
    const rows = buildUsageAccountQuotaRows(rateLimits, accounts)
    const wsl = rows.find((row) => row.key.endsWith(':wsl'))
    expect(wsl).toMatchObject({
      provider: { session: null, weekly: null, status: 'unavailable', updatedAt: 0 }
    })
    expect(rows.find((row) => row.key.endsWith(':work'))?.provider.session?.usedPercent).toBe(27)
  })

  it.each(['claude', 'codex'] as const)(
    'normalizes the default WSL target before assigning known %s quotas',
    (provider) => {
      const limits = createEmptyRateLimitState({
        [`${provider}Target`]: { runtime: 'wsl', wslDistro: null },
        [provider]: { ...quota(27, 'plus'), provider }
      })
      const accounts: ProviderAccountsSnapshot = {
        claude: { accounts: [], activeAccountId: null },
        codex: { accounts: [], activeAccountId: null },
        rateLimits: null
      }
      if (provider === 'codex') {
        accounts.codex = {
          accounts: [
            { ...account('linux', 'Linux'), managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
          ],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'linux' } }
        }
      } else {
        accounts.claude = {
          accounts: [
            {
              id: 'linux',
              email: 'wsl@example.test',
              managedAuthRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 2,
              lastAuthenticatedAt: 3
            }
          ],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'linux' } }
        }
      }
      const rows = buildUsageAccountQuotaRows(limits, accounts)
      expect(rows.find((row) => row.key === `${provider}:wsl:Ubuntu:linux`)).toMatchObject({
        active: true,
        provider: { status: 'ok', session: { usedPercent: 27 } }
      })
      expect(rows.some((row) => row.key.includes('__default__'))).toBe(false)
    }
  )

  it('marks every retained account unverifiable after host loss and labels legacy roster coverage', () => {
    const { accounts, rateLimits } = fixture()
    const rows = buildUsageAccountQuotaRows(rateLimits, accounts, true)
    expect(rows).toHaveLength(3)
    expect(
      rows.every(
        (row) =>
          row.provider.session === null &&
          row.provider.weekly === null &&
          row.provider.usageMetadata?.unverifiableOwner
      )
    ).toBe(true)
    render(
      <UsageAccountQuotas
        rateLimits={rateLimits}
        ownerLabel="Legacy host"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    )
    expect(screen.getByTestId('usage-quota-coverage')).toHaveTextContent(
      'Only reported accounts and current provider quota snapshots are shown'
    )
    expect(screen.getByTestId('usage-quota-codex')).toHaveTextContent('identity unavailable')
  })
  it('retains session, weekly and model windows together with their actual durations', () => {
    render(
      <UsageAccountQuotaCard
        provider={{
          ...quota(27, 'plus'),
          provider: 'claude',
          status: 'ok',
          error: null,
          buckets: [
            {
              name: 'Model group',
              usedPercent: 12,
              windowMinutes: 60,
              resetsAt: null,
              resetDescription: null
            }
          ],
          fableWeekly: {
            usedPercent: 7,
            windowMinutes: 10080,
            resetsAt: null,
            resetDescription: null
          }
        }}
      />
    )
    expect(screen.getAllByRole('progressbar')).toHaveLength(4)
    expect(screen.getByText('Model group · 1h')).toBeInTheDocument()
    expect(screen.getByText('Session · 5h')).toBeInTheDocument()
    expect(screen.getByText('Weekly · wk')).toBeInTheDocument()
    expect(screen.getByText('Fable · wk')).toBeInTheDocument()
  })
})
