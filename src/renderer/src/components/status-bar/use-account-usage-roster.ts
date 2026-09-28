import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState,
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { resolveClaudeStatusAccountState } from './status-bar-claude-accounts'
import { resolveCodexStatusAccountState } from './status-bar-codex-accounts'
import { getClaudeAccountSyncKey, getCodexAccountSyncKey } from './provider-account-sync-key'

const EMPTY_LIMITS = createEmptyRateLimitState()
const EMPTY_ACCOUNTS: ProviderAccountsSnapshot = {
  claude: emptyClaudeAccountsState(),
  codex: emptyCodexAccountsState(),
  rateLimits: null
}

function disconnectedUsage(state: RateLimitState): RateLimitState {
  const stale = (limits: ProviderRateLimits | null): ProviderRateLimits | null =>
    limits
      ? {
          ...limits,
          status: 'error',
          error: 'Remote usage connection unavailable'
        }
      : null
  return {
    ...state,
    claude: stale(state.claude),
    codex: stale(state.codex),
    gemini: stale(state.gemini),
    opencodeGo: stale(state.opencodeGo),
    kimi: stale(state.kimi),
    minimax: stale(state.minimax),
    grok: stale(state.grok),
    antigravity: stale(state.antigravity),
    inactiveClaudeAccounts: state.inactiveClaudeAccounts.map((entry) => ({
      ...entry,
      isFetching: false,
      rateLimits: stale(entry.rateLimits)
    })),
    inactiveCodexAccounts: state.inactiveCodexAccounts.map((entry) => ({
      ...entry,
      isFetching: false,
      rateLimits: stale(entry.rateLimits)
    }))
  }
}

export function useAccountUsageRoster() {
  const settings = useAppStore((s) => s.settings)
  const localLimits = useAppStore((s) => s.rateLimits)
  const visible = useAppStore((s) => s.statusBarVisible)
  const items = useAppStore((s) => s.statusBarItems)
  const fetchClaude = useAppStore((s) => s.fetchInactiveClaudeAccountUsage)
  const fetchCodex = useAppStore((s) => s.fetchInactiveCodexAccountUsage)
  const refreshLocal = useAppStore((s) => s.refreshRateLimits)
  const claudeKey = getClaudeAccountSyncKey(settings)
  const codexKey = getCodexAccountSyncKey(settings)
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  const ownerKey = environmentId ? `environment:${environmentId}` : 'local'
  const ownerSettings = useMemo(
    () => ({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const [received, setReceived] = useState<{
    ownerKey: string
    snapshot: ProviderAccountsSnapshot
    failed?: boolean
  } | null>(null)
  const snapshot = received?.ownerKey === ownerKey ? received.snapshot : EMPTY_ACCOUNTS
  const showClaude = visible && items.includes('claude')
  const showCodex = visible && items.includes('codex')

  const markDisconnected = useCallback(() => {
    setReceived((previous) =>
      previous?.ownerKey === ownerKey ? { ...previous, failed: true } : previous
    )
  }, [ownerKey])

  useEffect(() => {
    if (!visible || (!environmentId && !showClaude && !showCodex)) {
      return
    }
    let closed = false
    const watcher = watchProviderAccounts(ownerSettings, {
      onSnapshot: (next) => {
        if (closed) {
          return
        }
        setReceived((previous) => {
          const sameOwner = previous?.ownerKey === ownerKey ? previous.snapshot : EMPTY_ACCOUNTS
          return {
            ownerKey,
            snapshot: {
              ...next,
              claude: next.failedProviders?.includes('claude') ? sameOwner.claude : next.claude,
              codex: next.failedProviders?.includes('codex') ? sameOwner.codex : next.codex
            }
          }
        })
      },
      onError: () => {
        if (!closed) {
          markDisconnected()
        }
      }
    })
    return () => {
      closed = true
      watcher.close()
    }
  }, [
    ownerSettings,
    ownerKey,
    visible,
    environmentId,
    claudeKey,
    codexKey,
    showClaude,
    showCodex,
    markDisconnected
  ])

  const refreshPreviews = useCallback(async () => {
    if (environmentId) {
      return
    }
    await Promise.all([
      showClaude ? fetchClaude() : undefined,
      showCodex ? fetchCodex() : undefined
    ])
  }, [environmentId, fetchClaude, fetchCodex, showClaude, showCodex])

  useEffect(() => {
    void refreshPreviews()
  }, [refreshPreviews, claudeKey, codexKey])

  const refreshUsage = useCallback(async () => {
    if (environmentId) {
      // The subscription delivers results; never install a late RPC snapshot after an owner change.
      try {
        await callRuntimeRpc(getActiveRuntimeTarget(ownerSettings), 'accounts.list', {
          refreshUsage: true
        })
      } catch {
        markDisconnected()
      }
      return
    }
    await Promise.all([refreshLocal(), refreshPreviews()])
  }, [environmentId, ownerSettings, refreshLocal, refreshPreviews, markDisconnected])

  const accounts: ProviderAccountsSnapshot = {
    ...snapshot,
    claude: resolveClaudeStatusAccountState(settings, snapshot.claude),
    codex: resolveCodexStatusAccountState(settings, snapshot.codex)
  }
  const remoteLimits = snapshot.rateLimits ?? EMPTY_LIMITS
  return {
    accounts,
    ownerKey,
    rateLimits: environmentId
      ? received?.ownerKey === ownerKey && received.failed
        ? disconnectedUsage(remoteLimits)
        : remoteLimits
      : localLimits,
    refreshUsage,
    refreshPreviews
  }
}
