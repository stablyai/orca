// Orca Cloud plan & billing, as the desktop sees it. The billing service
// (cloud/apps/billing) is the authority; these mirror its /v1/billing responses.

export const ORCA_BILLING_PLAN_IDS = ['pro', 'max', 'team'] as const
export type OrcaBillingPlanId = (typeof ORCA_BILLING_PLAN_IDS)[number]

export type OrcaBillingDenyReason =
  | 'no_subscription'
  | 'subscription_inactive'
  | 'payment_past_due'
  | 'included_hours_exhausted'
  | 'overage_cap_reached'

export type OrcaBillingEntitlement = {
  plan: OrcaBillingPlanId | null
  planLabel: string | null
  /** Stripe subscription status, or 'none'. */
  status: string
  seats: number
  period: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  overageSeconds: number
  overageEnabled: boolean
  overageCapSeconds: number
  canStartSandbox: boolean
  reason: OrcaBillingDenyReason | null
  canManageBilling: boolean
  /** Plans on offer, from the billing service's catalog (prices are config there, not here). */
  plans: OrcaBillingPlanOption[]
}

export type OrcaBillingPlanOption = {
  plan: OrcaBillingPlanId
  label: string
  /** Display only, e.g. "$25/mo"; Stripe charges the configured price. */
  priceLabel: string
  includedHours: number
  /** Team: hours are per seat and pooled. */
  perSeat: boolean
}

export type OrcaBillingStatusResult =
  | { status: 'ok'; entitlement: OrcaBillingEntitlement }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'failed'; error: string }

export type OrcaBillingCheckoutArgs = {
  plan: OrcaBillingPlanId
  seats?: number
}

export type OrcaBillingOpenResult =
  | { status: 'opened' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'forbidden' }
  | { status: 'already-subscribed' }
  | { status: 'no-billing-account' }
  | { status: 'failed'; error: string }

export function isOrcaBillingPlanId(value: unknown): value is OrcaBillingPlanId {
  return ORCA_BILLING_PLAN_IDS.some((plan) => plan === value)
}
