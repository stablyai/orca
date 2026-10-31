import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { useActiveAccountOwner } from '@/runtime/use-worktree-runtime-target'
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
  const languageRevision = useUiLanguageRevision()
  // Why: route by the focused workspace's owner, never by the Active Server setting.
  const activeOwner = useActiveAccountOwner(LOCAL_TARGET)
  const target = ownerTarget ?? activeOwner.target
  const ownerId = runtimeTargetEnvironmentId(target)
  const localAccountRates = ownerId === null && includeAccounts ? local : null
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
    (owner: string, snapshot: ProviderAccountsSnapshot) => {
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
      if (!includeAccounts) {
        return
      }
      let active = true
      const watcher = watchProviderAccounts(LOCAL_TARGET, {
        onSnapshot: (snapshot) => {
          if (active) {
            apply({
              ownerId: null,
              rateLimits: localAccountRates,
              accounts: snapshot,
              failure: null
            })
          }
        },
        onError: () => {
          if (active) {
            fail(null, 'unreachable')
          }
        }
      })
      return () => {
        active = false
        watcher.close()
      }
    }
    let active = true
    const reopen = (): void => setStreamGeneration((value) => value + 1)
    // Why: orcad does not poll on its own, so a long-lived stream would freeze the meters.
    const staleTimer = setTimeout(reopen, REMOTE_USAGE_STALE_REOPEN_MS)
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const lost = (): void => {
      if (active) {
        fail(ownerId, 'unreachable')
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(reopen, REMOTE_USAGE_RECONNECT_DELAY_MS)
      }
    }
    const watcher = watchProviderAccounts(
      { kind: 'environment', environmentId: ownerId },
      {
        onSnapshot: (snapshot) => {
          if (active) {
            applySnapshot(ownerId, snapshot)
          }
        },
        // Why: timeout, closed stream and RPC failure all mean the owner's usage is unverifiable.
        onError: lost,
        onClosedAfterSnapshot: lost
      }
    )
    return () => {
      active = false
      clearTimeout(staleTimer)
      clearTimeout(reconnectTimer)
      watcher.close()
    }
  }, [ownerId, streamGeneration, includeAccounts, localAccountRates, applySnapshot, fail, apply])

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
              translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server')
          }
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [ownerId, ownerName, languageRevision]
  )

  const ownerState = useMemo<OwnerUsageState>(() => {
    if (!remoteOwner) {
      return { kind: 'local' }
    }
    if (!owned || owned.ownerId !== remoteOwner.environmentId) {
      return { kind: 'remote-pending' }
    }
    if (owned.failure) {
      return {
        kind: 'remote-unverifiable',
        ownerLabel: remoteOwner.label,
        reason: owned.failure,
        lastKnown: owned.rateLimits
      }
    }
    return owned.rateLimits
      ? { kind: 'remote', ownerLabel: remoteOwner.label, rateLimits: owned.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteOwner, owned])

  const rateLimits = useMemo(
    () => resolveOwnerUsageRateLimits(local, ownerState),
    [local, ownerState]
  )
  return {
    rateLimits,
    accounts:
      owned?.ownerId === ownerId && (ownerId !== null || owned.rateLimits === local)
        ? owned.accounts
        : null,
    accountsUnverifiable: owned?.ownerId === ownerId && owned.failure !== null,
    remoteOwner,
    refreshRemote: ownerId ? refreshRemote : null
  }
}
