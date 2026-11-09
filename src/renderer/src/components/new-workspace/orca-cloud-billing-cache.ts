import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import {
  toOrcaCloudRunTargetAccess,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'

/**
 * One billing-status read shared by the Run-on picker and the selection hint. The composer prefetches
 * it on mount so the Orca Cloud row rarely shows a loading state; focus refreshes it at most every
 * STALE_MS (the user may come back from Checkout or the portal). The result is keyed by account and
 * org, so a switch never shows the previous one's entitlement, and a newer read always wins.
 */
const STALE_MS = 30_000

type CacheState = {
  result: OrcaBillingStatusResult | null
  /** Account/org the result belongs to. */
  authKey: string | null
  loading: boolean
  fetchedAt: number
}

let state: CacheState = { result: null, authKey: null, loading: false, fetchedAt: 0 }
let inFlight: { generation: number; authKey: string; promise: Promise<void> } | null = null
let generation = 0
const listeners = new Set<() => void>()

function set(next: CacheState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function currentAuthKey(): string {
  const status = useAppStore.getState().orcaProfileAuthStatus
  return `${status?.activeProfileId}:${status?.state}:${status?.cloud?.activeOrgId}`
}

/**
 * Starts a read unless a matching one is running or the cached one is fresh for this account.
 * `force` (after an in-app billing change) always starts a new read that supersedes any running one.
 */
export function prefetchOrcaCloudBilling(force = false): Promise<void> {
  const authKey = currentAuthKey()
  if (!force && inFlight && inFlight.authKey === authKey) {
    return inFlight.promise
  }
  const fresh = state.authKey === authKey && Date.now() - state.fetchedAt < STALE_MS
  if (!force && state.result && fresh) {
    return Promise.resolve()
  }
  const mine = ++generation
  const read = async (): Promise<OrcaBillingStatusResult> => {
    try {
      return await window.api.orcaProfiles.billingStatus()
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }
  const promise = read().then((result) => {
    // A newer read, a reset, or an account switch supersedes this one.
    if (mine !== generation) {
      return
    }
    inFlight = null
    set({ result, authKey, loading: false, fetchedAt: Date.now() })
  })
  inFlight = { generation: mine, authKey, promise }
  set({ ...state, loading: true })
  return promise
}

/**
 * After billing changes in-app (overage, cap) the cached read is wrong: refetch now if anyone is
 * listening. `refetchNow: false` only marks it stale, for fixes that finish elsewhere (plans,
 * portal), so the next mount or focus reads again instead of trusting a 30s-fresh answer.
 */
export function invalidateOrcaCloudBilling({ refetchNow = true } = {}): void {
  set({ ...state, fetchedAt: 0 })
  if (refetchNow && listeners.size > 0) {
    void prefetchOrcaCloudBilling(true)
  }
}

function accessFrom(snapshot: CacheState, authKey: string): OrcaCloudRunTargetAccess {
  const result = snapshot.authKey === authKey ? snapshot.result : null
  if (!result && snapshot.loading) {
    return { state: 'loading' }
  }
  return toOrcaCloudRunTargetAccess(result)
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
  while (inFlight && !timedOut) {
    await Promise.race([inFlight.promise, deadline])
  }
  clearTimeout(timer)
  const access = accessFrom(state, currentAuthKey())
  return access.state === 'loading' ? { state: 'unknown' } : access
}

/** Subscribes to the shared read and keeps it fresh while `enabled`. */
export function useOrcaCloudRunTargetAccess(enabled: boolean): OrcaCloudRunTargetAccess {
  const snapshot = useSyncExternalStore(subscribe, () => state)
  const authKey = useAppStore((s) => {
    const status = s.orcaProfileAuthStatus
    return `${status?.activeProfileId}:${status?.state}:${status?.cloud?.activeOrgId}`
  })
  // Re-runs on account/org change: the keyed cache then reads as empty and refetches.
  useEffect(() => {
    if (!enabled) {
      return
    }
    void prefetchOrcaCloudBilling()
    const onFocus = (): void => void prefetchOrcaCloudBilling()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, authKey])
  return useMemo(() => accessFrom(snapshot, authKey), [snapshot, authKey])
}

/** Test seam: forget the cached read and orphan any running one. */
export function resetOrcaCloudBillingCache(): void {
  generation += 1
  inFlight = null
  set({ result: null, authKey: null, loading: false, fetchedAt: 0 })
}
