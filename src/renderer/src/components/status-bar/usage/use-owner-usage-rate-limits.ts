import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  applyOwnerAccountsSnapshot,
  readOwnerAccounts,
  readOwnerAccountsRevision,
  subscribeOwnerAccounts
} from '@/runtime/provider-accounts/observations/owner-accounts-stream'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../store/index'
import { resolveOwnerUsageRateLimits, type OwnerUsageState } from './owner-usage-rate-limits'

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
  accountsUnverifiable: boolean
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

/** One owner's accounts and usage: this device's store, or the host's own accounts stream.
 *  `includeAccounts` follows this device's live accounts stream too, so its roster and quotas agree. */
export function useAccountOwnerUsage(
  owner: AccountOwner,
  local: RateLimitState,
  includeAccounts = false
): OwnerUsageRateLimits {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const ownerId = runtimeTargetEnvironmentId(owner.target)
  const ownerName = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === ownerId)?.name ?? null
  )
  const followed = ownerId !== null || includeAccounts
  const subscribe = useCallback(
    (listener: () => void) =>
      followed ? subscribeOwnerAccounts(ownerId, listener) : () => undefined,
    [followed, ownerId]
  )
  const read = useCallback(
    () => (followed ? readOwnerAccounts(ownerId) : null),
    [followed, ownerId]
  )
  const owned = useSyncExternalStore(subscribe, read, read)

  const refreshRemote = useCallback(async () => {
    if (!ownerId) {
      return
    }
    const revision = readOwnerAccountsRevision(ownerId)
    try {
      const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
        { kind: 'environment', environmentId: ownerId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      // Keyed by host, so a refresh that outlives an owner switch lands on its own host only;
      // a stream update meanwhile supersedes it.
      applyOwnerAccountsSnapshot(ownerId, snapshot, revision)
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

  const localOwnerLabel = t('stats.usage.localHost', 'This device')
  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner && !includeAccounts) {
      return { kind: 'local' }
    }
    const ownerLabel = remoteOwner?.label ?? localOwnerLabel
    if (!owned) {
      return { kind: 'remote-pending' }
    }
    if (owned.failure) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel,
        reason: owned.failure,
        lastKnown: owned.snapshot?.rateLimits ?? null
      }
    }
    return owned.snapshot?.rateLimits
      ? { kind: 'remote', ownerLabel, rateLimits: owned.snapshot.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteOwner, includeAccounts, owned, localOwnerLabel])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState, t),
    [local, ownerState, t]
  )
  return {
    owner,
    rateLimits,
    accounts: owned?.snapshot ?? null,
    accountsUnverifiable: owned !== null && owned.failure !== null,
    remoteOwner,
    refreshRemote: ownerId ? refreshRemote : null
  }
}
