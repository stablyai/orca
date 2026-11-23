import { visibleAccountHostId } from '@/lib/workspace/ownership/visible-account-surface'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  applyOwnerAccountsSnapshot,
  currentOwnerAccountsStream,
  readOwnerAccounts,
  subscribeOwnerAccounts
} from '@/runtime/provider-accounts/observations/owner-accounts-stream'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../store/index'
import {
  isOwnerReturnToLocal,
  resolveOwnerUsageRateLimits,
  type OwnerUsageState
} from './owner-usage-rate-limits'

// Why: accounts.list({refreshUsage}) waits for the host's provider fetches.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 30_000
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A remote host (SSH-managed server or paired Orca) that owns the shown usage. */
export type RemoteUsageOwner = {
  environmentId: string | null
  label: string
  unavailableReason?: string
}

/** The Settings host that owns the shown usage, so its accounts open beside the bar's numbers. */
export function getUsageOwnerHostScope(
  remoteOwner: RemoteUsageOwner | null
): RuntimeClientTarget | null {
  return remoteOwner
    ? remoteOwner.environmentId
      ? { kind: 'environment', environmentId: remoteOwner.environmentId }
      : null
    : LOCAL_TARGET
}

export type OwnerUsageRateLimits = {
  /** Whose accounts the shown usage belongs to; account switchers list this owner's accounts. */
  owner: AccountOwner | null
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
  const owner = useActiveAccountOwner(LOCAL_TARGET)
  const visibleHostLabel = useAppStore((s) => {
    const host = visibleAccountHostId(s)
    return host ? selectExecutionHostDisplayLabel(s, host) : null
  })
  const previousOwner = useRef(owner)

  useEffect(() => {
    const returnedToLocal = isOwnerReturnToLocal(previousOwner.current, owner)
    previousOwner.current = owner
    if (returnedToLocal) {
      void window.api.rateLimits
        .refreshOnOwnerReturn()
        .catch((error) => console.warn('[usage] owner-return refresh failed', error))
    }
  }, [owner])

  return useAccountOwnerUsage(owner, local, false, visibleHostLabel)
}

/**
 * One owner's accounts and usage: this device's store, or the host's own accounts stream.
 * A null (unproven) or WSL owner has no account transport, so it shows unavailable usage.
 */
export function useAccountOwnerUsage(
  owner: AccountOwner | null,
  local: RateLimitState,
  includeAccounts = false,
  hostLabel: string | null = null
): OwnerUsageRateLimits {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const wslDistro = owner?.wslHostDistro ?? null
  const unavailable = owner === null || wslDistro !== null
  const ownerId = owner && !wslDistro ? runtimeTargetEnvironmentId(owner.target) : null
  const ownerName = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === ownerId)?.name ?? null
  )
  const followed = ownerId !== null || (includeAccounts && !unavailable)
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
    const startedOn = currentOwnerAccountsStream(ownerId)
    try {
      const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
        { kind: 'environment', environmentId: ownerId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      // Keyed by host and stream, so a refresh that outlives an owner switch never becomes current.
      applyOwnerAccountsSnapshot(ownerId, snapshot, startedOn)
    } catch {
      // Why: a slow forced refresh is not loss of contact; the stream owns reachability.
    }
  }, [ownerId])

  const remoteOwner = useMemo<RemoteUsageOwner | null>(
    () =>
      unavailable || ownerId
        ? {
            environmentId: ownerId,
            unavailableReason: wslDistro
              ? t(
                  'auto.components.status.bar.UsageRosterPanel.wslUsageNotShown',
                  "WSL usage isn't shown yet"
                )
              : undefined,
            label:
              hostLabel ||
              (wslDistro ? `WSL ${wslDistro}` : null) ||
              ownerName?.trim() ||
              t('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server')
          }
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [ownerId, ownerName, hostLabel, unavailable, wslDistro, languageRevision, t]
  )

  const localOwnerLabel = t('stats.usage.localHost', 'This device')
  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner && !includeAccounts) {
      return { kind: 'local' }
    }
    const ownerLabel = remoteOwner?.label ?? localOwnerLabel
    if (unavailable) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel,
        reason: 'unsupported-owner',
        lastKnown: null
      }
    }
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
  }, [remoteOwner, includeAccounts, owned, localOwnerLabel, unavailable])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState, t),
    [local, ownerState, t]
  )
  return {
    owner,
    rateLimits,
    accounts: owned?.snapshot ?? null,
    accountsUnverifiable: unavailable || (owned !== null && owned.failure !== null),
    remoteOwner,
    refreshRemote: ownerId || unavailable ? refreshRemote : null
  }
}
