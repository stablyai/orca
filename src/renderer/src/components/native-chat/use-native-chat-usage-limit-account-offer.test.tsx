// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'

const selectCodex = vi.fn(async () => ({ accounts: [], activeAccountId: 'b' }))
const selectClaude = vi.fn(async () => ({ accounts: [], activeAccountId: 'b' }))
type TestRoster = { accounts: { id: string; email: string }[]; activeAccountId: string | null }
const roster: { codex: TestRoster; claude: TestRoster } = {
  codex: { accounts: [], activeAccountId: 'a' },
  claude: { accounts: [], activeAccountId: 'a' }
}

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(async () => ({ ...roster, failedProviders: [] }))
}))
vi.mock('../status-bar/provider-account-selection', () => ({
  selectCodexAccountLikeStatusBar: selectCodex,
  selectClaudeAccountLikeStatusBar: selectClaude
}))

const { useNativeChatUsageLimitAccountOffer, usageLimitPercentLeft } =
  await import('./use-native-chat-usage-limit-account-offer')

const LOCAL: RuntimeClientTarget = { kind: 'local' }

function limits(session: number, weekly: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: { usedPercent: session, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: { usedPercent: weekly, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function usage(accountId: string, rateLimits: ProviderRateLimits | null): InactiveAccountUsage {
  return { accountId, rateLimits, updatedAt: 1, isFetching: false }
}

function render(agent: 'codex' | 'claude', target: RuntimeClientTarget = LOCAL) {
  const continueUsageLimit = vi.fn()
  const hook = renderHook(() =>
    useNativeChatUsageLimitAccountOffer({
      agent,
      target,
      wslDistro: null,
      blocked: true,
      continueUsageLimit
    })
  )
  return { ...hook, continueUsageLimit }
}

beforeEach(() => {
  roster.codex = {
    accounts: [
      { id: 'a', email: 'a@example.com' },
      { id: 'b', email: 'b@example.com' },
      { id: 'c', email: 'c@example.com' }
    ],
    activeAccountId: 'a'
  }
  roster.claude = { accounts: [{ id: 'a', email: 'a@example.com' }], activeAccountId: 'a' }
  useAppStore.setState((state) => ({
    settings: null,
    fetchInactiveCodexAccountUsage: async () => {},
    fetchInactiveClaudeAccountUsage: async () => {},
    rateLimits: {
      ...state.rateLimits,
      // b has 74% left in its tighter window; c has none left.
      inactiveCodexAccounts: [usage('b', limits(10, 26)), usage('c', limits(100, 40))],
      inactiveClaudeAccounts: []
    }
  }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useNativeChatUsageLimitAccountOffer', () => {
  it('offers the signed-in account with the most room, by its tightest window', async () => {
    const { result } = render('codex')
    await waitFor(() => expect(result.current?.kind).toBe('switch'))
    expect(result.current).toMatchObject({ account: 'b@example.com', percentLeft: 74 })
  })

  it('switches the picker as the status bar does, then continues the chat', async () => {
    const { result, continueUsageLimit } = render('codex')
    await waitFor(() => expect(result.current?.kind).toBe('switch'))
    const offer = result.current
    act(() => {
      if (offer?.kind === 'switch') {
        offer.switchAndContinue()
      }
    })
    await waitFor(() => expect(continueUsageLimit).toHaveBeenCalledTimes(1))
    expect(selectCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: LOCAL,
        accountId: 'b',
        target: { runtime: 'host', wslDistro: null }
      })
    )
  })

  it('offers Add account when the agent has no other account', async () => {
    const { result } = render('claude')
    await waitFor(() => expect(result.current?.kind).toBe('add'))
  })

  it('keeps the notice as it is when the other accounts have no room or unknown usage', async () => {
    useAppStore.setState((state) => ({
      rateLimits: {
        ...state.rateLimits,
        inactiveCodexAccounts: [usage('b', limits(100, 10)), usage('c', null)]
      }
    }))
    const { result } = render('codex')
    await act(async () => {})
    expect(result.current).toBeNull()
  })

  it('offers nothing for a chat on a remote server, whose usage this desktop does not hold', async () => {
    const { result } = render('codex', { kind: 'environment', environmentId: 'server-1' })
    await act(async () => {})
    expect(result.current).toBeNull()
  })

  it('reads room from the tightest window, and unknown when no window is reported', () => {
    expect(usageLimitPercentLeft(limits(30, 80))).toBe(20)
    expect(usageLimitPercentLeft(null)).toBeNull()
  })
})
