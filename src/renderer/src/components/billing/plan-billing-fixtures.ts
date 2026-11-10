// Shared sample entitlements for billing tests and component fixtures.
import type { OrcaBillingEntitlement, OrcaBillingOffers } from '../../../../shared/orca-billing'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

const HOUR = 3600

export const sampleOffers: OrcaBillingOffers = {
  team: {
    label: 'Team',
    monthlyPriceLabel: '$50 per seat per month',
    annualPriceLabel: '$480 per seat, billed yearly',
    monthlyPriceCentsPerSeat: 5000,
    annualPriceCentsPerSeat: 48000,
    largeMachineWeight: 1,
    includedHoursPerSeat: 60,
    concurrentSandboxesPerSeat: 3,
    idleSleepMinutes: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
    overageCentsPerHour: 100,
    defaultSpendCapCents: 2500,
    maxSpendCapCents: 500_000
  },
  enterprise: {
    label: 'Enterprise',
    priceLabel: 'Custom',
    contactUrl: 'https://onorca.dev/contact-sales'
  }
}

export const sampleTeam: OrcaBillingEntitlement = {
  plan: 'team',
  planLabel: 'Team',
  status: 'active',
  interval: 'month',
  seats: 2,
  seatChange: null,
  period: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3) },
  usageWindow: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3) },
  cancelAtPeriodEnd: false,
  includedSeconds: 120 * HOUR,
  usedSeconds: 41.5 * HOUR,
  remainingIncludedSeconds: 78.5 * HOUR,
  usageWarningPercent: null,
  overageSeconds: 0,
  overage: { optedIn: false, active: false, spendCapCents: 2500, spentCents: 0, centsPerHour: 100 },
  payment: { pastDueSince: null, graceEndsAt: null, suspendRunning: false },
  canStartSandbox: true,
  reason: null,
  canManageBilling: true,
  offers: sampleOffers
}

/** A team on its one-time trial: 2 sandbox hours, 0.6 used, no plan, no card. */
export const sampleTrial: OrcaBillingEntitlement = {
  ...sampleTeam,
  plan: null,
  planLabel: null,
  status: 'trial',
  interval: null,
  seats: 0,
  period: null,
  usageWindow: null,
  trial: {
    includedSeconds: 2 * HOUR,
    usedSeconds: 0.6 * HOUR,
    remainingSeconds: 1.4 * HOUR,
    exhausted: false,
    grantedAt: Date.UTC(2026, 10, 10)
  },
  includedSeconds: 2 * HOUR,
  usedSeconds: 0.6 * HOUR,
  remainingIncludedSeconds: 1.4 * HOUR,
  offers: { ...sampleOffers, trial: null }
}

/** The same team once its trial hours are used up. */
export const sampleTrialUsedUp: OrcaBillingEntitlement = {
  ...sampleTrial,
  trial: {
    includedSeconds: 2 * HOUR,
    usedSeconds: 2 * HOUR,
    remainingSeconds: 0,
    exhausted: true,
    grantedAt: Date.UTC(2026, 10, 10)
  },
  usedSeconds: 2 * HOUR,
  remainingIncludedSeconds: 0,
  usageWarningPercent: 100,
  canStartSandbox: false,
  reason: 'trial_used_up'
}
