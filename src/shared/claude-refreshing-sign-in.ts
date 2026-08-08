import type { ProviderRateLimits, UsageRateLimitFailureKind } from './rate-limit-types'

/** Failure kinds that surface as "Refreshing sign-in" while Orca tries in-app repair. */
export const CLAUDE_REFRESHING_FAILURE_KINDS = [
  'stale-token',
  'refreshable-credentials-without-token',
  'delegated-refresh-required'
] as const satisfies readonly UsageRateLimitFailureKind[]

export type ClaudeRefreshingFailureKind = (typeof CLAUDE_REFRESHING_FAILURE_KINDS)[number]

// Why: short enough to stop the chip from looking stuck forever, long enough that
// a successful in-app OAuth/CLI repair can finish without flapping into re-auth.
export const CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS = 2 * 60 * 1000

export function isClaudeRefreshingFailureKind(
  kind: UsageRateLimitFailureKind | undefined
): kind is ClaudeRefreshingFailureKind {
  return (
    kind === 'stale-token' ||
    kind === 'refreshable-credentials-without-token' ||
    kind === 'delegated-refresh-required'
  )
}

/**
 * Stamp / preserve when Claude usage first entered a transient "refreshing" failure.
 * Continuous polls must keep the original timestamp so the UI can escalate.
 */
export function stampClaudeRefreshingSince(
  fresh: ProviderRateLimits,
  previous: ProviderRateLimits | null,
  now = Date.now()
): ProviderRateLimits {
  if (fresh.provider !== 'claude') {
    return fresh
  }

  const kind = fresh.usageMetadata?.failureKind
  if (fresh.status !== 'error' || !isClaudeRefreshingFailureKind(kind)) {
    if (fresh.usageMetadata?.refreshingSinceMs == null) {
      return fresh
    }
    const { refreshingSinceMs: _drop, ...restMeta } = fresh.usageMetadata
    return {
      ...fresh,
      usageMetadata: restMeta
    }
  }

  const previousContinuous =
    previous?.provider === 'claude' &&
    previous.status === 'error' &&
    isClaudeRefreshingFailureKind(previous.usageMetadata?.failureKind)

  const refreshingSinceMs =
    previousContinuous && previous.usageMetadata?.refreshingSinceMs != null
      ? previous.usageMetadata.refreshingSinceMs
      : (fresh.usageMetadata?.refreshingSinceMs ?? now)

  return {
    ...fresh,
    usageMetadata: {
      ...fresh.usageMetadata,
      refreshingSinceMs
    }
  }
}

export function isClaudeRefreshingSignInEscalated(
  provider: ProviderRateLimits,
  now = Date.now()
): boolean {
  if (provider.provider !== 'claude' || provider.status !== 'error') {
    return false
  }
  if (!isClaudeRefreshingFailureKind(provider.usageMetadata?.failureKind)) {
    return false
  }
  const since = provider.usageMetadata?.refreshingSinceMs
  if (since == null) {
    return false
  }
  return now - since >= CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS
}
