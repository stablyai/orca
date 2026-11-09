// What the always-visible upgrade entry points need to know: does this account have a plan?
// Read when the account (or org) changes and refreshed by any billing view that loads status.
import { useSyncExternalStore } from 'react'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { isActivePlan } from './team/team-seat-math'

export type BillingSummary = {
  /** null until the first read answers (or when billing is off for this build/account). */
  subscribed: boolean | null
  canManageBilling: boolean
}

let summary: BillingSummary = { subscribed: null, canManageBilling: false }
const listeners = new Set<() => void>()
let lastReadAt = 0
let inFlight: Promise<void> | null = null
const MIN_REFRESH_MS = 60_000

export function recordBillingStatus(result: OrcaBillingStatusResult): void {
  const next: BillingSummary =
    result.status === 'ok'
      ? {
          subscribed: isActivePlan(result.entitlement),
          canManageBilling: result.entitlement.canManageBilling
        }
      : result.status === 'failed'
        ? summary
        : { subscribed: null, canManageBilling: false }
  if (
    next.subscribed !== summary.subscribed ||
    next.canManageBilling !== summary.canManageBilling
  ) {
    summary = next
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Re-reads billing status at most once a minute unless `force` (account or org switched). */
export function refreshBillingSummary(force = false): Promise<void> {
  if (inFlight || (!force && Date.now() - lastReadAt < MIN_REFRESH_MS)) {
    return inFlight ?? Promise.resolve()
  }
  lastReadAt = Date.now()
  inFlight = window.api.orcaProfiles
    .billingStatus()
    .then(recordBillingStatus)
    .catch(() => undefined)
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function getBillingSummary(): BillingSummary {
  return summary
}

export function subscribeBillingSummary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBillingSummary(): BillingSummary {
  return useSyncExternalStore(subscribeBillingSummary, getBillingSummary)
}
