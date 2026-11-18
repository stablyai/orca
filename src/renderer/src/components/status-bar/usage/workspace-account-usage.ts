import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

export function workspaceAccountUsage(
  state: RateLimitState,
  provider: 'claude' | 'codex',
  accountId: string | undefined
): ProviderRateLimits | null {
  if (!accountId) {
    return state[provider]
  }
  const primary = state[provider]
  if (primary?.usageMetadata?.unverifiableOwner) {
    return { ...primary, session: null, weekly: null, fableWeekly: null, extraUsage: null }
  }
  const cached = (
    provider === 'codex' ? state.inactiveCodexAccounts : state.inactiveClaudeAccounts
  ).find((entry) => entry.accountId === accountId)
  const reading =
    primary?.usageMetadata?.readingAccount?.accountId === accountId ? primary : cached?.rateLimits
  const matching = reading?.usageMetadata?.readingAccount?.accountId
  const usage: ProviderRateLimits =
    reading && matching === accountId
      ? reading
      : {
          provider,
          session: null,
          weekly: null,
          updatedAt: 0,
          error: null,
          status: cached?.isFetching ? 'fetching' : 'unavailable'
        }
  return {
    ...usage,
    usageMetadata: {
      ...usage.usageMetadata,
      contextAccountId: accountId,
      ...(primary?.usageMetadata?.unverifiableOwner ? { unverifiableOwner: true } : {})
    }
  }
}
