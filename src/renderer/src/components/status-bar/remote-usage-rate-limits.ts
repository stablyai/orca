import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  fetchProviderAccountsSnapshot,
  hasRemoteProviderAccountOwner,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'
import {
  latestUsageUpdatedAt,
  type RemoteUsageFailureReason,
  type RemoteUsageState
} from './usage-rate-limits-source'

type RemoteUsageSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export type RemoteUsageRateLimits = {
  state: RemoteUsageState
  /**
   * Forces the owning server to re-read usage, or null when the local machine
   * owns it and the caller should run its own refresh instead.
   */
  refresh: (() => Promise<void>) | null
}

/**
 * A snapshot is only meaningful next to the server it came from: switching
 * server A -> B closes A's watcher but an in-flight callback can still land,
 * and the old numbers would render under B's name.
 */
type OwnedUsageSnapshot = {
  ownerId: string | null
  rateLimits: RateLimitState | null
  failure: RemoteUsageFailureReason | null
}

// Why: a fresh accounts.subscribe makes the host run refreshIfStale, but the
// `ready` frame it answers with is emitted *before* that refresh. Hold the
// spinner until newer data actually arrives, and cap the wait so a host that
// throttled the refetch (or has nothing new) still releases the button.
const REMOTE_USAGE_REFRESH_SETTLE_TIMEOUT_MS = 8_000

export function resolveRemoteUsageOwnerLabel(
  environments: readonly { id: string; name?: string | null }[] | null | undefined,
  ownerId: string | null
): string {
  const name = environments?.find((environment) => environment.id === ownerId)?.name?.trim()
  return (
    name || translate('auto.components.status.bar.StatusBar.remoteServerLabel', 'Remote server')
  )
}

/**
 * Streams the usage numbers of whichever machine owns provider accounts (#15798).
 *
 * The provider-accounts snapshot the accounts roster already consumes carries
 * the server's full RateLimitState, so no new RPC or stream opcode is needed.
 * A watcher error - or a host that answers without usage - resolves to
 * `remote-unverifiable` rather than an endless spinner: per
 * docs/reference/ssh-execution-boundary.md, losing contact with the execution
 * host is its own verdict and must not be rendered as progress.
 */
export function useRemoteUsageRateLimits(settings: RemoteUsageSettings): RemoteUsageRateLimits {
  const remoteUsageOwner = hasRemoteProviderAccountOwner(settings)
  const ownerId = settings?.activeRuntimeEnvironmentId?.trim() || null
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const [owned, setOwned] = useState<OwnedUsageSnapshot | null>(null)
  const ownedRef = useRef<OwnedUsageSnapshot | null>(null)
  const pendingRefreshRef = useRef<{ afterUpdatedAt: number; settle: () => void } | null>(null)

  // Why: a failed watcher must not erase the numbers the server already vouched
  // for; the bars keep their slots and carry the verdict instead of vanishing.
  const lastKnownFor = useCallback((owner: string | null): RateLimitState | null => {
    const current = ownedRef.current
    return current && current.ownerId === owner ? current.rateLimits : null
  }, [])

  const applyOwned = useCallback((next: OwnedUsageSnapshot) => {
    ownedRef.current = next
    setOwned(next)
    const pending = pendingRefreshRef.current
    if (pending && latestUsageUpdatedAt(next.rateLimits) > pending.afterUpdatedAt) {
      pending.settle()
    }
  }, [])

  useEffect(() => {
    ownedRef.current = null
    setOwned(null)
    pendingRefreshRef.current?.settle()
    if (!remoteUsageOwner) {
      return
    }
    let active = true
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId: ownerId },
      {
        onSnapshot: (snapshot) => {
          if (!active) {
            return
          }
          if (!snapshot.rateLimits) {
            // Why: a host too old to publish usage still counts as the watcher's
            // first snapshot, disarming its timeout. Dropping it would pin the
            // badge on a spinner with no error path and no recovery.
            applyOwned({
              ownerId,
              rateLimits: lastKnownFor(ownerId),
              failure: 'usage-not-published'
            })
            return
          }
          applyOwned({ ownerId, rateLimits: snapshot.rateLimits, failure: null })
        },
        onError: () => {
          if (!active) {
            return
          }
          // Why: the watcher reports a first-snapshot timeout, a closed
          // subscription and RPC failures through this one channel. All of them
          // mean the same thing for the badge - the owner cannot be reached, so
          // its usage is unverifiable, not zero and not still loading.
          applyOwned({ ownerId, rateLimits: lastKnownFor(ownerId), failure: 'unreachable' })
        }
      }
    )
    return () => {
      active = false
      watcher.close()
      pendingRefreshRef.current?.settle()
    }
  }, [remoteUsageOwner, ownerId, applyOwned, lastKnownFor])

  const refresh = useCallback(async () => {
    const current = ownedRef.current
    const afterUpdatedAt =
      current?.ownerId === ownerId ? latestUsageUpdatedAt(current.rateLimits) : 0
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    let timer = 0
    const entry = {
      afterUpdatedAt,
      settle: (): void => {
        window.clearTimeout(timer)
        if (pendingRefreshRef.current === entry) {
          pendingRefreshRef.current = null
        }
        resolveSettled()
      }
    }
    timer = window.setTimeout(entry.settle, REMOTE_USAGE_REFRESH_SETTLE_TIMEOUT_MS)
    pendingRefreshRef.current?.settle()
    pendingRefreshRef.current = entry
    try {
      const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: ownerId })
      if (snapshot.rateLimits) {
        applyOwned({ ownerId, rateLimits: snapshot.rateLimits, failure: null })
      } else {
        applyOwned({ ownerId, rateLimits: lastKnownFor(ownerId), failure: 'usage-not-published' })
        entry.settle()
      }
    } catch {
      applyOwned({ ownerId, rateLimits: lastKnownFor(ownerId), failure: 'unreachable' })
      entry.settle()
    }
    await settled
  }, [ownerId, applyOwned, lastKnownFor])

  const ownerLabel = useMemo(
    () => resolveRemoteUsageOwnerLabel(runtimeEnvironments, ownerId),
    [runtimeEnvironments, ownerId]
  )

  const state = useMemo<RemoteUsageState>(() => {
    if (!remoteUsageOwner) {
      return { kind: 'local' }
    }
    // Why: a render can run with the new owner before the effect has torn the
    // old watcher down, so a snapshot is only used under the owner it names.
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
      ? { kind: 'remote', rateLimits: owned.rateLimits }
      : { kind: 'remote-pending' }
  }, [remoteUsageOwner, owned, ownerId, ownerLabel])

  return { state, refresh: remoteUsageOwner ? refresh : null }
}
