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
  /** The team's one-time trial hours are used up (no plan yet). */
  | 'trial_used_up'
  /** The team never had a plan and can't get a trial (one was already used by this account or team). */
  | 'trial_unavailable'

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
  // 'no plan' is the hosted provider's older log line for a missing plan. Both trial reasons are
  // fixed by choosing a plan, so they read as "needs a plan" everywhere.
  switch (reason) {
    case 'no_subscription':
    case 'subscription_inactive':
    case 'no plan':
    case 'trial_used_up':
    case 'trial_unavailable':
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
  /** The one-time trial this caller could still start for the team; null when none is on offer. */
  trial?: { includedSeconds: number } | null
}

/** The team's one-time trial (no card, no Stripe). Hours don't reset; a plan ends it. */
export type OrcaBillingTrial = {
  includedSeconds: number
  usedSeconds: number
  remainingSeconds: number
  exhausted: boolean
  grantedAt: number
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
  /**
   * The trial while it is the team's plan (status 'trial'); null otherwise. During a trial,
   * includedSeconds/usedSeconds/remainingIncludedSeconds mirror it and concurrency is 1.
   */
  trial?: OrcaBillingTrial | null
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
  payment: {
    pastDueSince: number | null
    graceEndsAt: number | null
    suspendRunning: boolean
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
  /** The plans dialog joins an open cloud setup session: Checkout then returns to its next step. */
  setupSessionId?: string
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
  /** Personal account: every plan lands on a team, so the caller starts cloud setup instead. */
  | { status: 'team-required' }
  | { status: 'failed'; error: string }

export type OrcaBillingOverageResult =
  | { status: 'ok'; entitlement: OrcaBillingEntitlement }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'forbidden' }
  | { status: 'no-subscription' }
  | { status: 'cap-too-high' }
  | { status: 'failed'; error: string }

/** The top entries of a usage breakdown, and everything past them in one line. */
export type OrcaBillingUsageTop = {
  top: { id: string; seconds: number }[]
  otherCount: number
  otherSeconds: number
}

/** The last 30 days of sandbox hours (Plan & billing). Breakdowns are owners and admins only. */
export type OrcaBillingUsageHistory = {
  /** Oldest first; `start` is the viewer's local midnight in epoch ms. */
  days: { start: number; seconds: number }[]
  totalSeconds: number
  yourSeconds: number
  members: OrcaBillingUsageTop | null
  sandboxes: OrcaBillingUsageTop | null
}

export type OrcaBillingUsageHistoryResult =
  | { status: 'ok'; history: OrcaBillingUsageHistory }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
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

/** The team is on its one-time trial (used up or not), with no plan. */
export function isOrcaCloudTrial(
  entitlement: Pick<OrcaBillingEntitlement, 'trial' | 'status'> | null | undefined
): boolean {
  return entitlement?.trial != null && entitlement.status === 'trial'
}

export type OrcaBillingTrialClaimResult =
  | { status: 'ok'; entitlement: OrcaBillingEntitlement }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  /** The trial can't be granted (abuse limits, already used, or the team had a plan). */
  | { status: 'unavailable' }
  /** A personal account: setup creates a team first (O1). */
  | { status: 'team-required' }
  | { status: 'failed'; error: string }

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
export const ORCA_PLAN_BILLING_SETTINGS_TARGET = {
  pane: 'orca-account'
} as const
export type OrcaOpenSettingsTarget = typeof ORCA_PLAN_BILLING_SETTINGS_TARGET
export type OrcaBillingReturn = {
  kind: 'checkout-success' | 'checkout-cancel' | 'portal'
}

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
