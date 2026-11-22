import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  applyOwnerAccountsSnapshot,
  readOwnerAccounts,
  subscribeOwnerAccounts
} from '@/runtime/provider-accounts/observations/owner-accounts-stream'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../store/index'
import { resolveOwnerUsageRateLimits, type OwnerUsageState } from './owner-usage-rate-limits'
import {
  getCodexStatusActiveId,
  scopeCodexAuthFailure
} from '../accounts/status-bar-codex-accounts'

// Why: accounts.list({refreshUsage}) waits for the host's provider fetches.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 30_000
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A remote host (SSH-managed server or paired Orca) that owns the shown usage. */
export type RemoteUsageOwner = {
  environmentId: string
  label: string
}

/** The Settings host that owns the shown usage, so its accounts open beside the bar's numbers. */
export function getUsageOwnerHostScope(remoteOwner: RemoteUsageOwner | null): RuntimeClientTarget {
  return remoteOwner
    ? { kind: 'environment', environmentId: remoteOwner.environmentId }
    : LOCAL_TARGET
}

export type OwnerUsageRateLimits = {
  /** Whose accounts the shown usage belongs to; account switchers list this owner's accounts. */
  owner: AccountOwner
  rateLimits: RateLimitState
  accounts: ProviderAccountsSnapshot | null
  /** Null when this device owns the shown usage. */
  remoteOwner: RemoteUsageOwner | null
  /** Forces the owning host to re-read usage; null when this device owns it. */
  refreshRemote: (() => Promise<void>) | null
}

/** Read provider usage from the focused workspace’s account owner, including that host’s own remote snapshot. */
export function useOwnerUsageRateLimits(local: RateLimitState): OwnerUsageRateLimits {
  // Why: route by the focused workspace's owner, never by the Active Server setting.
  return useAccountOwnerUsage(useActiveAccountOwner(LOCAL_TARGET), local)
}

/** One owner's accounts and usage: this device's store, or the host's own accounts stream. */
export function useAccountOwnerUsage(
  owner: AccountOwner,
  local: RateLimitState
): OwnerUsageRateLimits {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const ownerId = runtimeTargetEnvironmentId(owner.target)
  const ownerName = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === ownerId)?.name ?? null
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      ownerId ? subscribeOwnerAccounts(ownerId, listener) : () => undefined,
    [ownerId]
  )
  const read = useCallback(() => (ownerId ? readOwnerAccounts(ownerId) : null), [ownerId])
  const owned = useSyncExternalStore(subscribe, read, read)

  const refreshRemote = useCallback(async () => {
    if (!ownerId) {
      return
    }
    try {
      const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
        { kind: 'environment', environmentId: ownerId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      // Keyed by host, so a refresh that outlives an owner switch lands on its own host only.
      applyOwnerAccountsSnapshot(ownerId, snapshot)
    } catch {
      // Why: a slow forced refresh is not loss of contact; the stream owns reachability.
    }
  }, [ownerId])

  const remoteOwner = useMemo<RemoteUsageOwner | null>(
    () =>
      ownerId
        ? {
            environmentId: ownerId,
            label:
              ownerName?.trim() ||
              t('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server')
          }
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [ownerId, ownerName, languageRevision, t]
  )

  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner) {
      return { kind: 'local' }
    }
    if (!owned) {
      return { kind: 'remote-pending' }
    }
    if (owned.failure) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel: remoteOwner.label,
        reason: owned.failure,
        lastKnown: owned.snapshot?.rateLimits ?? null
      }
    }
    return owned.snapshot?.rateLimits
      ? { kind: 'remote', ownerLabel: remoteOwner.label, rateLimits: owned.snapshot.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteOwner, owned])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState, t),
    [local, ownerState, t]
  )
  const authFailureAccount = rateLimits.codex?.usageMetadata?.authFailureAccount
  const localActiveCodexId = useAppStore((s) => {
    if (ownerId || !authFailureAccount || !s.settings) {
      return null
    }
    return getCodexStatusActiveId(
      {
        activeAccountId: s.settings.activeCodexManagedAccountId ?? null,
        activeAccountIdsByRuntime: s.settings.activeCodexManagedAccountIdsByRuntime
      },
      authFailureAccount
    )
  })
  const hostCodexAccounts = owned?.snapshot?.codex
  const scopedRateLimits = useMemo(() => {
    if (!rateLimits.codex || !authFailureAccount) {
      return rateLimits
    }
    const target = rateLimits.codexTarget
    const matchesRuntime =
      authFailureAccount.runtime === target.runtime &&
      (!target.wslDistro || authFailureAccount.wslDistro === target.wslDistro)
    const selectedAccountId = !ownerId
      ? localActiveCodexId
      : hostCodexAccounts && getCodexStatusActiveId(hostCodexAccounts, authFailureAccount)
    const activeAccountId = matchesRuntime ? (selectedAccountId ?? null) : null
    const codex = scopeCodexAuthFailure(rateLimits.codex, activeAccountId)
    // An unpinned WSL read already resolved its distro in main.
    const resolvedDistro =
      activeAccountId === authFailureAccount.accountId ? authFailureAccount.wslDistro : null
    const codexTarget =
      target.runtime === 'wsl' && !target.wslDistro && resolvedDistro
        ? { ...target, wslDistro: resolvedDistro }
        : target
    return codex === rateLimits.codex && codexTarget === target
      ? rateLimits
      : { ...rateLimits, codex, codexTarget }
  }, [authFailureAccount, hostCodexAccounts, localActiveCodexId, ownerId, rateLimits])
  return {
    owner,
    rateLimits: scopedRateLimits,
    accounts: owned?.snapshot ?? null,
    remoteOwner,
    refreshRemote: ownerId ? refreshRemote : null
  }
}
