// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CodexManagedAccountSummary } from '../../../../shared/agent-accounts/managed-account-types'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { UsageAccountQuotas, UsageAccountQuotaCard } from './UsageAccountQuotas'
import { buildUsageAccountQuotaRows } from './usage-account-quota-rows'

vi.mock('../../store', () => ({ useAppStore: () => vi.fn() }))
vi.mock('@/components/agent/icons/AgentIcon', () => ({ AgentIcon: () => <span /> }))
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

function renderQuotas(
  rateLimits: RateLimitState,
  props: { accounts?: ProviderAccountsSnapshot; accountsUnverifiable?: boolean } = {}
): void {
  render(
    <UsageAccountQuotas
      rateLimits={rateLimits}
      ownerLabel="Build server"
      onRefresh={() => {}}
      onManage={() => {}}
      {...props}
    />
  )
}

afterEach(cleanup)

describe('account quotas', () => {
  it('shows each reported account under its host with plan, windows and source errors', () => {
    const { accounts, rateLimits } = fixture()
    renderQuotas(rateLimits, { accounts })
    const cards = screen.getAllByTestId('usage-quota-codex')
    expect(cards).toHaveLength(3)
    expect(cards[0]).toHaveTextContent('same@example.test (Work)')
    expect(cards[0]).toHaveTextContent('Build server · Active')
    expect(cards[0]).not.toHaveTextContent('This device')
    expect(cards[0]).toHaveTextContent('Business')
    expect(cards[0]).toHaveTextContent('27% used')
    expect(cards[1]).toHaveTextContent('same@example.test (Personal)')
    expect(cards[1]).toHaveTextContent('65% used')
    expect(within(cards[2]).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(cards[2]).toHaveTextContent('Fixture account unavailable')
    expect(cards[2]).toHaveTextContent('Quota data unavailable')
  })

  it('without an account list, shows reported Antigravity accounts and current accounts', () => {
    const antigravity = (percent: number): ProviderRateLimits => ({
      ...quota(percent, 'plus'),
      provider: 'antigravity'
    })
    const saved = (email: string, active: boolean, rateLimits: ProviderRateLimits | null) => ({
      accountId: email,
      email,
      active,
      rateLimits
    })
    renderQuotas(
      createEmptyRateLimitState({
        codex: quota(27, 'plus'),
        muse: { ...quota(12, 'plus'), provider: 'muse' },
        antigravity: antigravity(31),
        antigravityAccounts: [
          saved('active@example.test', true, antigravity(31)),
          saved('saved@example.test', false, antigravity(64)),
          saved('unread@example.test', false, null)
        ]
      })
    )
    const cards = screen.getAllByTestId('usage-quota-antigravity')
    expect(cards).toHaveLength(3)
    expect(cards[1]).toHaveTextContent('saved@example.test')
    expect(cards[1]).toHaveTextContent('64% used')
    expect(within(cards[2]).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('usage-quota-muse')).toHaveTextContent('12% used')
    expect(screen.getByTestId('usage-quota-codex')).toHaveTextContent('identity unavailable')
    expect(screen.getByTestId('usage-quota-coverage')).toHaveTextContent(
      'Only reported accounts and current provider quota snapshots are shown'
    )
  })

  it('keeps retained accounts unavailable when the account list cannot be verified', () => {
    const { accounts, rateLimits } = fixture()
    renderQuotas(rateLimits, { accounts, accountsUnverifiable: true })
    expect(screen.getByTestId('usage-quota-coverage')).toHaveTextContent(
      'The account list is unavailable or incomplete.'
    )
    expect(screen.getAllByTestId('usage-quota-codex')).toHaveLength(3)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })

  it('labels retained quota windows after a failed refresh', () => {
    render(<UsageAccountQuotaCard provider={{ ...quota(27, 'plus'), status: 'error' }} />)
    expect(screen.getByText('Last known quota; the latest check failed.')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('keeps model windows alongside the session and weekly windows', () => {
    const bucket = { usedPercent: 12, windowMinutes: 60, resetsAt: null, resetDescription: null }
    render(
      <UsageAccountQuotaCard
        provider={{
          ...quota(27, 'plus'),
          provider: 'claude',
          buckets: [{ ...bucket, name: 'Model group' }]
        }}
      />
    )
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    expect(screen.getByText('Model group · 1h')).toBeInTheDocument()
    expect(screen.getByText('Weekly')).toBeInTheDocument()
  })

  it('assigns default-WSL quotas only to the account active in that distro', () => {
    const { accounts } = fixture()
    accounts.codex.accounts.push({
      ...account('linux', 'Linux'),
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    accounts.codex.activeAccountIdsByRuntime = { host: 'work', wsl: { Ubuntu: 'linux' } }
    const limits = createEmptyRateLimitState({
      codexTarget: { runtime: 'wsl', wslDistro: null },
      codex: quota(27, 'plus')
    })
    const rows = buildUsageAccountQuotaRows(limits, accounts)
    expect(rows.find((row) => row.key === 'codex:wsl:Ubuntu:linux')).toMatchObject({
      active: true,
      provider: { session: { usedPercent: 27 } }
    })
    expect(rows.find((row) => row.key.endsWith(':work'))?.provider.session).toBeNull()
  })
})
