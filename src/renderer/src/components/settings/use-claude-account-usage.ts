import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { rateLimitTargetMatchesAccountRuntime } from './rate-limit-target-match'
import type { AccountRuntime } from './rate-limit-target-match'
import { getProviderAccountActiveIdForView } from './provider-account-visibility'

/**
 * Feeds the Accounts pane's per-row Claude usage: reads the rate-limit slices
 * and re-runs the inactive-account fetch when the roster or active account moves.
 */
export function useClaudeAccountUsage({
  isRemoteAccountScope,
  claudeAccounts,
  visibleAccountIds,
  accountRuntime
}: {
  isRemoteAccountScope: boolean
  claudeAccounts: ClaudeRateLimitAccountsState
  visibleAccountIds: string[]
  accountRuntime: AccountRuntime
}): {
  claudeUsageVisible: boolean
  claudeUsageTargetMatches: boolean
  claudeRateLimits: ReturnType<typeof useAppStore.getState>['rateLimits']['claude']
  inactiveClaudeAccounts: ReturnType<
    typeof useAppStore.getState
  >['rateLimits']['inactiveClaudeAccounts']
  claudeUsageFetchSettled: boolean
} {
  const claudeRateLimits = useAppStore((s) => s.rateLimits.claude)
  const claudeRateLimitTarget = useAppStore((s) => s.rateLimits.claudeTarget)
  const inactiveClaudeAccounts = useAppStore((s) => s.rateLimits.inactiveClaudeAccounts)
  const fetchInactiveClaudeAccountUsage = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  // Why: same remote gate the Codex auth warning uses. The desktop's
  // rate-limit poll says nothing about accounts owned by a remote runtime.
  const claudeUsageVisible = !isRemoteAccountScope
  const claudeUsageTargetMatches = rateLimitTargetMatchesAccountRuntime(
    claudeRateLimitTarget,
    accountRuntime
  )
  // Why: re-run the inactive fetch when the roster or the active account moves;
  // selecting an account leaves the outgoing one with no cache entry.
  const activeId = getProviderAccountActiveIdForView(claudeAccounts, accountRuntime)
  const rosterKey = `${activeId ?? 'system'}|${visibleAccountIds.join(',')}`
  // Why: without a settled flag a row whose account never gets a cache entry
  // would show the loading skeleton for the life of the pane.
  const [claudeUsageFetchSettled, setClaudeUsageFetchSettled] = useState(false)
  useEffect(() => {
    // Why: mirrors the switcher's fetch-on-open (StatusBar) so opening this pane
    // fills inactive-account usage. The service debounces, so a revisit is cheap.
    if (!claudeUsageVisible) {
      return
    }
    let cancelled = false
    setClaudeUsageFetchSettled(false)
    void fetchInactiveClaudeAccountUsage().finally(() => {
      if (!cancelled) {
        setClaudeUsageFetchSettled(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [claudeUsageVisible, rosterKey, fetchInactiveClaudeAccountUsage])
  return {
    claudeUsageVisible,
    claudeUsageTargetMatches,
    claudeRateLimits,
    inactiveClaudeAccounts,
    claudeUsageFetchSettled
  }
}
