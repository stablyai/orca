import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID } from '../../../../../shared/agent-accounts/workspace-account-binding'

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
  const systemDefault = accountId === WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID
  const primaryProvenance = primary?.usageMetadata?.authProvenance
  const primaryIsSystemDefault =
    !primaryProvenance?.startsWith('profile:') && !primary?.usageMetadata?.readingAccount?.accountId
  const cached = (
    provider === 'codex' ? state.inactiveCodexAccounts : state.inactiveClaudeAccounts
  ).find((entry) =>
    systemDefault
      ? (provider === 'codex' ? state.codexTarget : state.claudeTarget).runtime === 'host' &&
        entry.accountId.startsWith('system-default:host:')
      : entry.accountId === accountId
  )
  const reading = (
    systemDefault
      ? primary && primaryIsSystemDefault
      : primary?.usageMetadata?.readingAccount?.accountId === accountId
  )
    ? primary
    : cached?.rateLimits
  const matching = reading?.usageMetadata?.readingAccount?.accountId
  const usage: ProviderRateLimits =
    reading &&
    (systemDefault ? !matching || matching === cached?.accountId : matching === accountId)
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
