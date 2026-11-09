// What the always-visible upgrade entry points need to know: does this account have a plan?
// Read when the account (or org) changes and refreshed by any billing view that loads status.
import { useSyncExternalStore } from 'react'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { isActivePlan } from './team/team-seat-math'

export type BillingSummary = {
  /** null until the first read answers (or when billing is off for this build/account). */
  subscribed: boolean | null
  canManageBilling: boolean
  /** "Team" when subscribed; null otherwise. */
  planLabel: string | null
}

let summary: BillingSummary = { subscribed: null, canManageBilling: false, planLabel: null }
const listeners = new Set<() => void>()
let lastReadAt = 0
let inFlight: Promise<void> | null = null
const MIN_REFRESH_MS = 60_000

let lastStatus: OrcaBillingStatusResult | null = null

/** The latest successful status for the current account, to seed views that open later. */
export function getLastBillingStatus(): OrcaBillingStatusResult | null {
  return lastStatus
}

export function recordBillingStatus(result: OrcaBillingStatusResult): void {
  if (result.status === 'ok') {
    lastStatus = result
  } else if (result.status !== 'failed') {
    lastStatus = null
  }
  const next: BillingSummary =
    result.status === 'ok'
      ? {
          subscribed: isActivePlan(result.entitlement),
          canManageBilling: result.entitlement.canManageBilling,
          planLabel: isActivePlan(result.entitlement) ? result.entitlement.planLabel : null
        }
      : result.status === 'failed'
        ? summary
        : { subscribed: null, canManageBilling: false, planLabel: null }
  if (
    next.subscribed !== summary.subscribed ||
    next.canManageBilling !== summary.canManageBilling ||
    next.planLabel !== summary.planLabel
  ) {
    summary = next
    for (const listener of listeners) {
      listener()
    }
  }
}

/** Bumped on every account/org switch; answers from an older account are ignored. */
let generation = 0

export function getBillingGeneration(): number {
  return generation
}

/** Records a status read that started in `startedGeneration`; reads from a previous account are dropped. */
export function recordBillingStatusIfCurrent(
  startedGeneration: number,
  result: OrcaBillingStatusResult
): void {
  if (startedGeneration === generation) {
    recordBillingStatus(result)
  }
}

/** Forget the previous account's plan at once (sign-out, account or org switch). */
export function resetBillingSummary(): void {
  generation++
  inFlight = null
  lastReadAt = 0
  recordBillingStatus({ status: 'signed-out' })
}

/** Re-reads billing status at most once a minute unless `force` (account or org switched). */
export function refreshBillingSummary(force = false): Promise<void> {
  if (!force && (inFlight || Date.now() - lastReadAt < MIN_REFRESH_MS)) {
    return inFlight ?? Promise.resolve()
  }
  const requestGeneration = generation
  lastReadAt = Date.now()
  const request = window.api.orcaProfiles
    .billingStatus()
    .then((result) => {
      if (requestGeneration === generation) {
        recordBillingStatus(result)
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (inFlight === request) {
        inFlight = null
      }
    })
  inFlight = request
  return request
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
