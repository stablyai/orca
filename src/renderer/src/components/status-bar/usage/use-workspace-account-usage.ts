import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { workspaceAccountId } from '../../../../../shared/agent-accounts/workspace-account-binding'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace/identity/workspace-scope'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { workspaceAccountUsage } from './workspace-account-usage'

const USAGE_REFRESH_MS = 5 * 60_000

export function useWorkspaceAccountUsage(
  state: RateLimitState,
  provider: 'codex' | 'claude',
  remoteOwned: boolean,
  refreshOwner: (() => Promise<void>) | null
) {
  const workspaceId = useAppStore((s) =>
    getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const visible = useAppStore((s) => s.statusBarVisible)
  const localBindings = useAppStore((s) =>
    provider === 'codex' ? s.settings?.codexWorkspaceAccounts : s.settings?.claudeWorkspaceAccounts
  )
  const refreshLocal = useAppStore((s) => s.refreshRateLimits)
  const fetchInactive = useAppStore((s) =>
    provider === 'codex' ? s.fetchInactiveCodexAccountUsage : s.fetchInactiveClaudeAccountUsage
  )
  const remoteBindings =
    provider === 'codex' ? state.codexWorkspaceAccounts : state.claudeWorkspaceAccounts
  const accountId = workspaceAccountId(
    remoteOwned ? remoteBindings : (localBindings ?? remoteBindings),
    workspaceId ?? undefined
  )
  const primaryAccountId = state[provider]?.usageMetadata?.readingAccount?.accountId
  const readsInactive = Boolean(accountId && accountId !== primaryAccountId)

  useEffect(() => {
    if (!visible || remoteOwned || !readsInactive) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => void fetchInactive(),
      intervalMs: USAGE_REFRESH_MS,
      slowWhileUnfocused: true
    })
  }, [visible, remoteOwned, readsInactive, accountId, primaryAccountId, fetchInactive])

  const refresh = useCallback(async () => {
    await Promise.all([
      (refreshOwner ?? refreshLocal)(),
      !remoteOwned && readsInactive ? fetchInactive() : Promise.resolve()
    ])
  }, [refreshOwner, refreshLocal, remoteOwned, readsInactive, fetchInactive])

  const rateLimits = useMemo(
    () =>
      accountId
        ? { ...state, [provider]: workspaceAccountUsage(state, provider, accountId) }
        : state,
    [state, accountId, provider]
  )
  return { rateLimits, refresh: refreshOwner || readsInactive ? refresh : null }
}
