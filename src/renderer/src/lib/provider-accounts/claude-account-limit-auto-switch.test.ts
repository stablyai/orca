import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/agent-accounts/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'

type StoreListener = (state: unknown, previous: unknown) => void

const mocks = vi.hoisted(() => {
  const store: { listener: StoreListener | null; state: Record<string, unknown> } = {
    listener: null,
    state: {}
  }
  return {
    select: vi.fn(),
    handleSessions: vi.fn(),
    toastInfo: vi.fn(),
    toastWarning: vi.fn(),
    toastError: vi.fn(),
    store
  }
})

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, warning: mocks.toastWarning, error: mocks.toastError }
}))
vi.mock('@/runtime/provider-accounts/observations/runtime-provider-accounts-client', () => ({
  selectClaudeProviderAccount: mocks.select
}))
vi.mock('./claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: mocks.handleSessions
}))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.store.state,
    subscribe: (listener: StoreListener) => {
      mocks.store.listener = listener
      return () => {}
    }
  }
}))

import { registerClaudeAccountLimitAutoSwitch } from './claude-account-limit-auto-switch'

function usage(session: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: session, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function account(
  id: string,
  extra: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

function accounts(activeId: string): ClaudeRateLimitAccountsState {
  return {
    accounts: [
      account('active'),
      account('busy'),
      account('fresh'),
      account('signed-out', { needsSignIn: true }),
      account('wsl', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ],
    activeAccountId: activeId,
    activeAccountIdsByRuntime: { host: activeId, wsl: {} }
  }
}

function start(rateLimits: RateLimitState): void {
  vi.stubGlobal('window', {
    api: {
      rateLimits: {
        fetchInactiveClaudeAccounts: vi.fn(async () => {}),
        get: vi.fn(async () => rateLimits)
      },
      claudeAccounts: { list: vi.fn(async () => accounts('active')) }
    }
  })
  const previous = { settings: null, rateLimits: createEmptyRateLimitState() }
  mocks.store.state = {
    settings: { claudeAccountAutoSwitchAtLimit: true },
    rateLimits,
    fetchSettings: vi.fn(async () => {})
  }
  registerClaudeAccountLimitAutoSwitch([])
  mocks.store.listener?.(mocks.store.state, previous)
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('registerClaudeAccountLimitAutoSwitch', () => {
  it('selects the least-used signed-in host account and hands running sessions over', async () => {
    mocks.select.mockResolvedValue(accounts('fresh'))
    start(
      createEmptyRateLimitState({
        claude: usage(96),
        inactiveClaudeAccounts: [
          { accountId: 'busy', rateLimits: usage(70), updatedAt: 1, isFetching: false },
          { accountId: 'fresh', rateLimits: usage(10), updatedAt: 1, isFetching: false },
          { accountId: 'signed-out', rateLimits: usage(0), updatedAt: 1, isFetching: false },
          { accountId: 'wsl', rateLimits: usage(0), updatedAt: 1, isFetching: false }
        ]
      })
    )

    await vi.waitFor(() => expect(mocks.handleSessions).toHaveBeenCalled())
    expect(mocks.select).toHaveBeenCalledWith(
      { kind: 'local' },
      { accountId: 'fresh', runtime: 'host', wslDistro: null }
    )
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Switched Claude to fresh@example.com',
      expect.anything()
    )
    expect(mocks.handleSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ accountId: 'active' }),
        after: expect.objectContaining({ accountId: 'fresh' })
      })
    )
  })

  it('keeps the account and warns when every other account is over the threshold', async () => {
    start(
      createEmptyRateLimitState({
        claude: usage(99),
        inactiveClaudeAccounts: [
          { accountId: 'busy', rateLimits: usage(97), updatedAt: 1, isFetching: false },
          { accountId: 'fresh', rateLimits: usage(100), updatedAt: 1, isFetching: false }
        ]
      })
    )

    await vi.waitFor(() => expect(mocks.toastWarning).toHaveBeenCalled())
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
