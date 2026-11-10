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
  | 'payment_grace_expired'
  | 'included_hours_exhausted'
  | 'overage_cap_reached'

/**
 * What a plan refusal means, whatever surface shows it. Billing's account reasons plus the control
 * plane's start-gate reasons (concurrency, machine size) map to one category; each surface keeps its
 * own wording for the category. Unknown reasons (a newer service) fall to `other`.
 */
export type OrcaEntitlementDenialKind =
  | 'plan'
  | 'hours'
  | 'spendCap'
  | 'payment'
  | 'teamLimit'
  | 'memberLimit'
  | 'machineSize'
  | 'other'

export function classifyEntitlementDenial(
  reason: string | null | undefined
): OrcaEntitlementDenialKind {
  // 'no plan' is the hosted provider's older log line for a missing plan.
  switch (reason) {
    case 'no_subscription':
    case 'subscription_inactive':
    case 'no plan':
      return 'plan'
    case 'included_hours_exhausted':
      return 'hours'
    case 'overage_cap_reached':
      return 'spendCap'
    case 'payment_past_due':
    case 'payment_grace_expired':
      return 'payment'
    case 'concurrency_limit':
      return 'teamLimit'
    case 'member_concurrency_limit':
      return 'memberLimit'
    case 'machine_size_not_in_plan':
      return 'machineSize'
    case null:
    case undefined:
      return 'other'
    default:
      return 'other'
  }
}

export type OrcaBillingOffers = {
  team: {
    label: string
    /** Display only, e.g. "$50 per seat per month"; Stripe charges the configured price. */
    monthlyPriceLabel: string
    annualPriceLabel: string
    /** Per-seat prices in cents for totals and the annual saving; null from older services. */
    monthlyPriceCentsPerSeat: number | null
    annualPriceCentsPerSeat: number | null
    /** Legacy: billing now sells one size (1x), so this is 1 and the desktop no longer shows it. */
    largeMachineWeight: number
    includedHoursPerSeat: number
    concurrentSandboxesPerSeat: number
    idleSleepMinutes: number
    overageCentsPerHour: number
    defaultSpendCapCents: number
    /** Highest monthly spend cap billing accepts; null from older services. */
    maxSpendCapCents: number | null
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
  /** Seats stay at the period's peak; they come down to the member count at renewal. */
  seatChange: { seatsAtRenewal: number; effectiveAt: number } | null
  period: { start: number; end: number } | null
  /** Monthly window the hours count against (a slice of the year on annual plans). */
  usageWindow: { start: number; end: number } | null
  cancelAtPeriodEnd: boolean
  includedSeconds: number
  usedSeconds: number
  remainingIncludedSeconds: number
  /** Highest included-hours warning level reached (75, 90 or 100), or null. */
  usageWarningPercent: number | null
  overageSeconds: number
  overage: {
    optedIn: boolean
    active: boolean
    spendCapCents: number
    spentCents: number
    centsPerHour: number
  }
  /** Failed payment: new starts stop at once; running sandboxes suspend after `graceEndsAt`. */
  payment: { pastDueSince: number | null; graceEndsAt: number | null; suspendRunning: boolean }
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

/** Another team the signed-in user is on, and its plan state (cloud start B2, "Switch to <team>"). */
export type OrcaBillingTeamPlan = {
  orgId: string
  plan: string | null
  planLabel: string | null
  canStartSandbox: boolean
}

export type OrcaBillingTeamPlansResult =
  | { status: 'ok'; teams: OrcaBillingTeamPlan[] }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'failed'; error: string }

/** At most this many teams per lookup (the billing Worker's bound). */
export const ORCA_BILLING_TEAM_PLANS_MAX_ORGS = 10

export function isOrcaBillingPlanId(value: unknown): value is OrcaBillingPlanId {
  return ORCA_BILLING_PLAN_IDS.some((plan) => plan === value)
}

export function isOrcaBillingInterval(value: unknown): value is OrcaBillingInterval {
  return ORCA_BILLING_INTERVALS.some((interval) => interval === value)
}

/** Where Stripe's hosted pages send the browser back: the Worker's return page opens this link. */
export const ORCA_BILLING_RETURN_CHANNEL = 'billing:return'

/** Main asks the main window to re-read billing (cloud workspace created/woken, or the 30-min poll). */
export const ORCA_BILLING_REFRESH_CHANNEL = 'billing:refreshRequested'

/** Target sent with `ui:openSettings` to land on Settings › Orca account (Plan & billing). */
export const ORCA_PLAN_BILLING_SETTINGS_TARGET = { pane: 'orca-account' } as const
export type OrcaOpenSettingsTarget = typeof ORCA_PLAN_BILLING_SETTINGS_TARGET
export type OrcaBillingReturn = { kind: 'checkout-success' | 'checkout-cancel' | 'portal' }

/** Parses `orca://billing/return?checkout=success|cancel` or `?portal=return`; anything else is null. */
export function parseOrcaBillingReturnLink(raw: string): OrcaBillingReturn | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'orca:' || url.hostname !== 'billing' || url.pathname !== '/return') {
    return null
  }
  const checkout = url.searchParams.get('checkout')
  if (checkout === 'success') {
    return { kind: 'checkout-success' }
  }
  if (checkout === 'cancel') {
    return { kind: 'checkout-cancel' }
  }
  return url.searchParams.get('portal') === 'return' ? { kind: 'portal' } : null
}

export function findOrcaBillingReturnLink(argv: readonly string[]): OrcaBillingReturn | null {
  for (const arg of argv) {
    const parsed = parseOrcaBillingReturnLink(arg)
    if (parsed) {
      return parsed
    }
  }
  return null
}
