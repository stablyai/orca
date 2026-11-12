// Billing's running-sandbox caps, as the limit cards, cloud errors and predictive wake read them.
import {
  isOrcaCloudTrial,
  type OrcaBillingEntitlement,
  type OrcaBillingOffers,
  type OrcaBillingStatusResult
} from '../../../../shared/orca-billing'

/**
 * The running-sandbox caps billing enforces: per member and per team. `perSeat` is the team cap per
 * paid seat, null on the trial (no seats) or when it isn't a whole number per seat.
 */
export type SandboxLimit = {
  perMember: number
  team: number
  perSeat: number | null
  trial: boolean
}

/** The billing fields the caps derive from (any OrcaBillingStatusResult fits). */
export type SandboxLimitBillingStatus =
  | {
      status: 'ok'
      entitlement: Pick<OrcaBillingEntitlement, 'seats' | 'status' | 'trial' | 'limits'> & {
        offers: { team: Pick<OrcaBillingOffers['team'], 'concurrentSandboxesPerSeat'> } | null
      }
    }
  | { status: Exclude<OrcaBillingStatusResult['status'], 'ok'> }

/** Billing's checkStart caps (its `limits`; derived from the Team offer for older services). */
export function sandboxLimitFromBilling(
  status: SandboxLimitBillingStatus | null
): SandboxLimit | null {
  if (status?.status !== 'ok') {
    return null
  }
  const { entitlement } = status
  const trial = isOrcaCloudTrial(entitlement)
  const limits = entitlement.limits
  if (limits) {
    if (limits.maxConcurrentSandboxes <= 0) {
      return null
    }
    const seats = Math.max(1, entitlement.seats)
    const perSeat =
      trial || limits.maxConcurrentSandboxes % seats !== 0
        ? null
        : limits.maxConcurrentSandboxes / seats
    return {
      perMember: limits.maxConcurrentSandboxesPerMember || limits.maxConcurrentSandboxes,
      team: limits.maxConcurrentSandboxes,
      perSeat,
      trial
    }
  }
  // Older services send no limits; the Team offer's per-seat cap is wrong for a trial, so none.
  const perSeat = entitlement.offers?.team.concurrentSandboxesPerSeat
  if (!perSeat || trial) {
    return null
  }
  return {
    perMember: perSeat,
    team: perSeat * Math.max(1, entitlement.seats),
    perSeat,
    trial: false
  }
}
