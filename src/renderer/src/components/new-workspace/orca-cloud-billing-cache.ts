import { useEffect, useMemo } from 'react'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import {
  getBillingReadInFlight,
  getBillingState,
  hasBillingWatchers,
  markBillingStale,
  refreshBillingStatus,
  resetBillingSummary,
  useBillingState,
  watchBillingStatus,
  type BillingStoreState
} from '@/components/billing/billing-summary-store'
import {
  toOrcaCloudRunTargetAccess,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'
import { devBillingFaultAccess } from '@/lib/orca-cloud/run-on-preflight'

/**
 * The Run-on picker's and selection hint's view of the shared billing store. The composer prefetches
 * on mount so the Orca Cloud row rarely shows a loading state; focus re-reads at most every STALE_MS
 * (the user may come back from Checkout or the portal). The store is scoped to the account and team,
 * keeps the last good answer through a failed read, and a newer read always wins.
 */
const STALE_MS = 30_000

/**
 * Starts a read unless one is running or the cached answer is fresh for this account.
 * `force` (after an in-app billing change) always starts a new read that supersedes any running one.
 */
export function prefetchOrcaCloudBilling(force = false): Promise<void> {
  return refreshBillingStatus(force ? { supersede: true } : { maxAgeMs: STALE_MS })
}

/**
 * After billing changes in-app (overage, cap) the cached read is wrong: refetch now if anyone is
 * looking. `refetchNow: false` only marks it stale, for fixes that finish elsewhere (plans,
 * portal), so the next mount or focus reads again instead of trusting a 30s-fresh answer.
 */
export function invalidateOrcaCloudBilling({ refetchNow = true } = {}): void {
  markBillingStale()
  if (refetchNow && hasBillingWatchers()) {
    void prefetchOrcaCloudBilling(true)
  }
}

function accessFrom(snapshot: BillingStoreState): OrcaCloudRunTargetAccess {
  // Dev/QA: a simulated billing wall for real-app shots (never in production builds).
  const fault = devBillingFaultAccess()
  if (fault) {
    return fault
  }
  if (!snapshot.result && snapshot.loading) {
    return { state: 'loading' }
  }
  return toOrcaCloudRunTargetAccess(snapshot.result)
}

/** Resolves once billing has answered, or after `timeoutMs` with whatever is known then. */
export async function waitForOrcaCloudAccess(timeoutMs: number): Promise<OrcaCloudRunTargetAccess> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
  })
  // A superseded read resolves without data; keep waiting on whichever read is current.
  for (let read = getBillingReadInFlight(); read && !timedOut; read = getBillingReadInFlight()) {
    await Promise.race([read, deadline])
  }
  clearTimeout(timer)
  const access = accessFrom(getBillingState())
  return access.state === 'loading' ? { state: 'unknown' } : access
}

/** Subscribes to the shared read and keeps it fresh while `enabled`. */
export function useOrcaCloudRunTargetAccess(enabled: boolean): OrcaCloudRunTargetAccess {
  const snapshot = useBillingState()
  const accountKey = useOrcaAccountKey()
  // Re-runs on account/team change: the store then drops the old answer and reads the new one.
  useEffect(() => {
    if (!enabled) {
      return
    }
    const release = watchBillingStatus()
    void prefetchOrcaCloudBilling()
    const onFocus = (): void => void prefetchOrcaCloudBilling()
    window.addEventListener('focus', onFocus)
    return () => {
      release()
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, accountKey])
  return useMemo(() => accessFrom(snapshot), [snapshot])
}

/** Test seam: forget the cached read and orphan any running one. */
export function resetOrcaCloudBillingCache(): void {
  resetBillingSummary()
}
