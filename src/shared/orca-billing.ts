// Orca Cloud plan & billing, as the desktop sees it. The billing service
// (cloud/apps/billing) is the authority; these mirror its /v1/billing responses.
// One self-serve plan (Team, per seat, monthly or annual) plus Enterprise (contact sales).

export const ORCA_BILLING_PLAN_IDS = ['team'] as const
export type OrcaBillingPlanId = (typeof ORCA_BILLING_PLAN_IDS)[number]
export const ORCA_BILLING_INTERVALS = ['month', 'year'] as const
export type OrcaBillingInterval = (typeof ORCA_BILLING_INTERVALS)[number]
export const ORCA_BILLING_MAX_SEATS = 500

export type OrcaBillingDenyReason =
  | 'no_subscription'
  | 'subscription_inactive'
  | 'payment_past_due'
  | 'included_hours_exhausted'
  | 'overage_cap_reached'

export type OrcaBillingOffers = {
  team: {
    label: string
    /** Display only, e.g. "$50/seat/mo"; Stripe charges the configured price. */
    monthlyPriceLabel: string
    annualPriceLabel: string
    includedHoursPerSeat: number
    concurrentSandboxesPerSeat: number
    idleSleepMinutes: number
    overageCentsPerHour: number
    defaultSpendCapCents: number
  }
  enterprise: { label: string; priceLabel: string; contactUrl: string }
}

export type OrcaBillingEntitlement = {
  plan: OrcaBillingPlanId | null
  planLabel: string | null
  /** Stripe subscription status, or 'none'. */
  status: string
  interval: OrcaBillingInterval | null
  seats: number
  period: { start: number; end: number } | null
  /** Monthly window the hours count against (a slice of the year on annual plans). */
  usageWindow: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  /** Highest included-hours warning level reached (80, 100), or null. */
  usageWarningPercent: number | null
  overageSeconds: number
  overage: {
    optedIn: boolean
    active: boolean
    spendCapCents: number
    spentCents: number
    centsPerHour: number
  }
  canStartSandbox: boolean
  reason: OrcaBillingDenyReason | null
  canManageBilling: boolean
  /** What is on offer, from the billing service's catalog (prices are config there, not here). */
  offers: OrcaBillingOffers | null
}

export type OrcaBillingStatusResult =
  | { status: 'ok'; entitlement: OrcaBillingEntitlement }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'failed'; error: string }

export type OrcaBillingCheckoutArgs = {
  plan: OrcaBillingPlanId
  interval: OrcaBillingInterval
  seats: number
}

export type OrcaBillingOverageArgs = {
  enabled: boolean
  /** Whole cents; omitted keeps the current cap. */
  spendCapCents?: number
}

export type OrcaBillingOpenResult =
  | { status: 'opened' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'forbidden' }
  | { status: 'already-subscribed' }
  | { status: 'no-billing-account' }
  | { status: 'failed'; error: string }

export type OrcaBillingOverageResult =
  | { status: 'ok'; entitlement: OrcaBillingEntitlement }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'forbidden' }
  | { status: 'no-subscription' }
  | { status: 'cap-too-high' }
  | { status: 'failed'; error: string }

export function isOrcaBillingPlanId(value: unknown): value is OrcaBillingPlanId {
  return ORCA_BILLING_PLAN_IDS.some((plan) => plan === value)
}

export function isOrcaBillingInterval(value: unknown): value is OrcaBillingInterval {
  return ORCA_BILLING_INTERVALS.some((interval) => interval === value)
}
