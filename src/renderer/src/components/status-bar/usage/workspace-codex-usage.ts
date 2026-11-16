import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

export function workspaceCodexUsage(
  state: RateLimitState,
  accountId: string | undefined
): ProviderRateLimits | null {
  if (!accountId) {
    return state.codex
  }
  const primary = state.codex
  const cached = state.inactiveCodexAccounts.find((entry) => entry.accountId === accountId)
  const reading =
    primary?.usageMetadata?.readingAccount?.accountId === accountId ? primary : cached?.rateLimits
  const matching = reading?.usageMetadata?.readingAccount?.accountId
  const usage: ProviderRateLimits =
    reading && (!matching || matching === accountId)
      ? reading
      : {
          provider: 'codex',
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
