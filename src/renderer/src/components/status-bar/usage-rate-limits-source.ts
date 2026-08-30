import type { RateLimitState } from '../../../../shared/rate-limit-types'

/**
 * Which machine's usage the status-bar badges describe (#15798).
 *
 * With a remote Active Server, agents run there and the provider-accounts
 * snapshot carries the server's full RateLimitState — the badges must show
 * those numbers, not the viewer's local poll (which describes a machine that
 * runs nothing and can look correct while being wrong). While the first
 * remote snapshot is still in flight, the Claude/Codex rows degrade to a
 * fetching state rather than flashing local numbers.
 */
export function resolveStatusBarUsageRateLimits(
  localRateLimits: RateLimitState,
  remoteRateLimits: RateLimitState | null,
  remoteUsageOwner: boolean
): RateLimitState {
  if (!remoteUsageOwner) {
    return localRateLimits
  }
  if (remoteRateLimits) {
    return remoteRateLimits
  }
  return {
    ...localRateLimits,
    claude: markProviderFetching(localRateLimits.claude),
    codex: markProviderFetching(localRateLimits.codex)
  }
}

function markProviderFetching<T extends { status: string } | null>(provider: T): T | null {
  return provider ? { ...provider, status: 'fetching' } : null
}
