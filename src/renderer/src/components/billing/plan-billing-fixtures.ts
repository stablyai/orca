// Shared sample entitlements for billing tests and component fixtures.
import type { OrcaBillingEntitlement, OrcaBillingOffers } from '../../../../shared/orca-billing'

const HOUR = 3600

export const sampleOffers: OrcaBillingOffers = {
  team: {
    label: 'Team',
    monthlyPriceLabel: '$50/seat/mo',
    annualPriceLabel: '$480/seat/yr',
    includedHoursPerSeat: 60,
    concurrentSandboxesPerSeat: 3,
    idleSleepMinutes: 15,
    overageCentsPerHour: 75,
    defaultSpendCapCents: 2500
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
  period: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3) },
  usageWindow: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3) },
  cancelAtPeriodEnd: false,
  includedSeconds: 120 * HOUR,
  usedSeconds: 41.5 * HOUR,
  remainingIncludedSeconds: 78.5 * HOUR,
  usageWarningPercent: null,
  overageSeconds: 0,
  overage: { optedIn: false, active: false, spendCapCents: 2500, spentCents: 0, centsPerHour: 75 },
  canStartSandbox: true,
  reason: null,
  canManageBilling: true,
  offers: sampleOffers
}
