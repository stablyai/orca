// Shared sample entitlements for billing tests and component fixtures.
import type {
  OrcaBillingEntitlement,
  OrcaBillingOffers,
  OrcaBillingUsageHistory
} from '../../../../shared/orca-billing'
import type { UsageNames } from './plan-billing-usage-history'
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
    warnAtPercent: [75, 90, 100],
    maxSpendCapCents: 500_000
  },
  enterprise: {
    label: 'Enterprise',
    priceLabel: 'Custom',
    contactUrl: 'https://orca.dev/enterprise'
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

const DAY_MS = 24 * 3600 * 1000
// Hours per day, oldest first: quiet weekends, a busy release week and today in progress.
const DAILY_HOURS = [
  0.5, 1.2, 0, 0, 2.4, 3.1, 1.8, 2.2, 0.9, 0, 0, 1.4, 2.8, 4.6, 5.2, 3.9, 0.3, 0, 1.1, 2, 1.7, 2.6,
  0.8, 0, 0, 1.9, 3.4, 2.1, 1.5, 0.6
]
const HISTORY_START = Date.UTC(2026, 9, 12, 7)

export const sampleUsageHistory: OrcaBillingUsageHistory = {
  days: DAILY_HOURS.map((hours, index) => ({
    start: HISTORY_START + index * DAY_MS,
    seconds: Math.round(hours * HOUR)
  })),
  totalSeconds: Math.round(DAILY_HOURS.reduce((sum, hours) => sum + hours, 0) * HOUR),
  yourSeconds: 18.4 * HOUR,
  members: {
    top: [
      { id: 'u-neil', seconds: 18.4 * HOUR },
      { id: 'u-grace', seconds: 15.1 * HOUR },
      { id: 'u-linus', seconds: 8.6 * HOUR },
      { id: 'u-gone', seconds: 4.2 * HOUR }
    ],
    otherCount: 0,
    otherSeconds: 1.7 * HOUR
  },
  sandboxes: {
    top: [
      { id: 'sbx_checkout', seconds: 14.2 * HOUR },
      { id: 'sbx_ledger', seconds: 11 * HOUR },
      { id: 'sbx_docs', seconds: 7.3 * HOUR },
      { id: 'sbx_gone', seconds: 5.9 * HOUR },
      { id: 'sbx_deleted', seconds: 3.1 * HOUR }
    ],
    otherCount: 4,
    otherSeconds: 6.5 * HOUR
  }
}

export const sampleUsageNames: UsageNames = {
  selfId: 'u-neil',
  members: new Map([
    ['u-neil', 'Neil Parker'],
    ['u-grace', 'Grace Hopper'],
    ['u-linus', 'Linus Torvalds']
  ]),
  workspaces: new Map([
    ['sbx_checkout', 'Checkout retries'],
    ['sbx_ledger', 'Ledger migration'],
    ['sbx_docs', 'Docs search'],
    ['sbx_flaky', 'Flaky e2e repro']
  ])
}
