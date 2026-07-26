import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { isUnavailableInactiveUsage } from '../status-bar/usage-availability'

export type ClaudeRowUsage =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; limits: ProviderRateLimits; isFetching: boolean }
  | { kind: 'unavailable' }

/**
 * Picks what an Accounts-pane Claude row should show for usage.
 *
 * The active account reads the live poll; every other account reads the
 * per-account inactive cache the switcher already fills.
 */
export function resolveClaudeRowUsage({
  accountId,
  isActive,
  visible,
  targetMatchesRuntime,
  activeLimits,
  inactiveAccounts,
  inactiveFetchSettled
}: {
  accountId: string
  isActive: boolean
  visible: boolean
  targetMatchesRuntime: boolean
  activeLimits: ProviderRateLimits | null
  inactiveAccounts: readonly InactiveAccountUsage[]
  inactiveFetchSettled: boolean
}): ClaudeRowUsage {
  if (!visible) {
    return { kind: 'hidden' }
  }
  if (isActive) {
    // Why: the Claude poll can be retargeted to another runtime from the status
    // bar without changing this pane's account view, and a host percentage
    // shown on a WSL row is worse than showing nothing.
    if (!targetMatchesRuntime) {
      return { kind: 'hidden' }
    }
    if (!activeLimits) {
      return { kind: 'loading' }
    }
    if (isUnavailableInactiveUsage(activeLimits)) {
      return { kind: 'unavailable' }
    }
    return {
      kind: 'ready',
      limits: activeLimits,
      isFetching: activeLimits.status === 'fetching'
    }
  }
  const entry = inactiveAccounts.find((usage) => usage.accountId === accountId)
  if (!entry) {
    // Why: nothing re-runs the inactive fetch on its own, so once ours settles a
    // still-missing entry is the final answer rather than a pending one.
    return inactiveFetchSettled ? { kind: 'unavailable' } : { kind: 'loading' }
  }
  if (entry.rateLimits) {
    // Why: a failed credential read comes back as a snapshot with every window
    // null, not as a null snapshot. Without this it renders as usable data.
    return isUnavailableInactiveUsage(entry.rateLimits)
      ? { kind: 'unavailable' }
      : { kind: 'ready', limits: entry.rateLimits, isFetching: entry.isFetching }
  }
  return entry.isFetching ? { kind: 'loading' } : { kind: 'unavailable' }
}
