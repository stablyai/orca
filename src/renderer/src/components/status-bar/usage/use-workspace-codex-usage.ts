import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { codexWorkspaceAccountId } from '../../../../../shared/agent-accounts/codex/codex-workspace-account'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace/identity/workspace-scope'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { workspaceCodexUsage } from './workspace-codex-usage'

const USAGE_REFRESH_MS = 5 * 60_000

export function useWorkspaceCodexUsage(
  state: RateLimitState,
  remoteOwned: boolean,
  refreshOwner: (() => Promise<void>) | null
) {
  const workspaceId = useAppStore((s) =>
    getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const visible = useAppStore((s) => s.statusBarVisible)
  const localBindings = useAppStore((s) => s.settings?.codexWorkspaceAccounts)
  const refreshLocal = useAppStore((s) => s.refreshRateLimits)
  const fetchInactive = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const accountId = codexWorkspaceAccountId(
    remoteOwned ? state.codexWorkspaceAccounts : (localBindings ?? state.codexWorkspaceAccounts),
    workspaceId ?? undefined
  )
  const primaryAccountId = state.codex?.usageMetadata?.readingAccount?.accountId
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
    () => (accountId ? { ...state, codex: workspaceCodexUsage(state, accountId) } : state),
    [state, accountId]
  )
  return { rateLimits, refresh: refreshOwner || readsInactive ? refresh : null }
}
