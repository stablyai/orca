import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { useActiveAccountOwner } from '@/runtime/provider-accounts/ownership/use-active-account-owner'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '../../store'
import {
  resolveOwnerUsageRateLimits,
  type OwnerUsageFailureReason,
  type OwnerUsageState
} from './owner-usage-rate-limits'

// Why: accounts.list({refreshUsage}) waits for the host's provider fetches.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 30_000
// Matches the desktop's own usage poll cadence.
const REMOTE_USAGE_STALE_REOPEN_MS = 5 * 60_000
const REMOTE_USAGE_RECONNECT_DELAY_MS = 5_000
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A snapshot only counts under the owner it came from, so A's numbers never render as B's. */
type OwnedUsage = {
  ownerId: string | null
  rateLimits: RateLimitState | null
  accounts: ProviderAccountsSnapshot | null
  failure: OwnerUsageFailureReason | null
}

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
  rateLimits: RateLimitState
  accounts: ProviderAccountsSnapshot | null
  accountsUnverifiable: boolean
  /** Null when this device owns the shown usage. */
  remoteOwner: RemoteUsageOwner | null
  /** Forces the owning host to re-read usage; null when this device owns it. */
  refreshRemote: (() => Promise<void>) | null
}

/** Read provider usage from the focused workspace’s account owner, including that host’s own remote snapshot. */
export function useOwnerUsageRateLimits(
  local: RateLimitState,
  ownerTarget?: RuntimeClientTarget,
  includeAccounts = false
): OwnerUsageRateLimits {
  const t = useTranslate()
  // Why: route by the focused workspace's owner, never by the Active Server setting.
  const activeOwner = useActiveAccountOwner(LOCAL_TARGET)
  const target = ownerTarget ?? activeOwner.target
  const ownerId = runtimeTargetEnvironmentId(target)
  const ownerName = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === ownerId)?.name ?? null
  )
  const [owned, setOwned] = useState<OwnedUsage | null>(null)
  const ownedRef = useRef<OwnedUsage | null>(null)
  const usageGeneration = useRef(0)

  const apply = useCallback((next: OwnedUsage) => {
    usageGeneration.current += 1
    ownedRef.current = next
    setOwned(next)
  }, [])

  // Why: losing contact must not erase what the host already vouched for.
  const fail = useCallback(
    (owner: string | null, failure: OwnerUsageFailureReason) => {
      const current = ownedRef.current
      apply({
        ownerId: owner,
        rateLimits: current?.ownerId === owner ? current.rateLimits : null,
        accounts: current?.ownerId === owner ? current.accounts : null,
        failure
      })
    },
    [apply]
  )

  const applySnapshot = useCallback(
    (owner: string | null, snapshot: ProviderAccountsSnapshot) => {
      if (snapshot.rateLimits) {
        apply({
          ownerId: owner,
          rateLimits: snapshot.rateLimits,
          accounts: snapshot,
          failure: null
        })
      } else {
        // Why: a host that predates published usage answers without it; say so, never spin.
        apply({
          ownerId: owner,
          rateLimits: null,
          accounts: snapshot,
          failure: 'usage-not-published'
        })
      }
    },
    [apply]
  )

  const ownerIdRef = useRef(ownerId)
  useEffect(() => {
    ownerIdRef.current = ownerId
    usageGeneration.current += 1
  }, [ownerId])
  // Why: bumping reopens the stream; each open makes the host refresh stale usage.
  const [streamGeneration, setStreamGeneration] = useState(0)

  useEffect(() => {
    if (!ownerId) {
      return
    }
    // Older hosts do not poll usage for a paired stream.
    const timer = setTimeout(
      () => setStreamGeneration((value) => value + 1),
      REMOTE_USAGE_STALE_REOPEN_MS
    )
    return () => clearTimeout(timer)
  }, [ownerId, streamGeneration])

  useEffect(() => {
    if (!ownerId && !includeAccounts) {
      return
    }
    let active = true
    const reopen = (): void => setStreamGeneration((value) => value + 1)
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const lost = (): void => {
      if (active) {
        fail(ownerId, 'unreachable')
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(reopen, REMOTE_USAGE_RECONNECT_DELAY_MS)
      }
    }
    const watcher = watchProviderAccounts(
      ownerId ? { kind: 'environment', environmentId: ownerId } : LOCAL_TARGET,
      {
        onSnapshot: (snapshot) => {
          if (active) {
            applySnapshot(ownerId, snapshot)
          }
        },
        // Why: timeout, closed stream and RPC failure all mean the owner's usage is unverifiable.
        onError: lost,
        onClosedAfterSnapshot: lost
      },
      { liveLocalUsage: true }
    )
    return () => {
      active = false
      clearTimeout(reconnectTimer)
      watcher.close()
    }
  }, [ownerId, streamGeneration, includeAccounts, applySnapshot, fail])

  const refreshRemote = useCallback(async () => {
    if (!ownerId) {
      return
    }
    const generation = ++usageGeneration.current
    try {
      const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
        { kind: 'environment', environmentId: ownerId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      // A stream update, owner switch or newer refresh supersedes this request.
      if (ownerIdRef.current === ownerId && usageGeneration.current === generation) {
        applySnapshot(ownerId, snapshot)
      }
    } catch {
      // Why: a slow forced refresh is not loss of contact; the stream owns reachability.
    }
  }, [ownerId, applySnapshot])

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
    [ownerId, ownerName, t]
  )

  const localOwnerLabel = t('stats.usage.localHost', 'This device')
  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner && !includeAccounts) {
      return { kind: 'local' }
    }
    const ownerLabel = remoteOwner?.label ?? localOwnerLabel
    if (!owned || owned.ownerId !== ownerId) {
      return { kind: 'remote-pending' }
    }
    if (owned.failure) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel,
        reason: owned.failure,
        lastKnown: owned.rateLimits
      }
    }
    return owned.rateLimits
      ? { kind: 'remote', ownerLabel, rateLimits: owned.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteOwner, includeAccounts, ownerId, owned, localOwnerLabel])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState, t),
    [local, ownerState, t]
  )
  return {
    rateLimits,
    accounts: owned?.ownerId === ownerId ? owned.accounts : null,
    accountsUnverifiable: owned?.ownerId === ownerId && owned.failure !== null,
    remoteOwner,
    refreshRemote: ownerId ? refreshRemote : null
  }
}
