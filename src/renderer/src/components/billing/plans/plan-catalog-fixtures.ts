// A sample of billing's GET /v1/plans (as the main process parses it) for tests and fixtures:
// the launch catalog (cloud/apps/billing/catalog/catalog.json) with Stripe TEST prices.
import type {
  OrcaPlanCatalog,
  OrcaPlanCatalogResult
} from '../../../../../shared/orca-billing-plans'

export const sampleCatalog: OrcaPlanCatalog = {
  catalogVersion: 'c_sample',
  plans: [
    {
      kind: 'trial',
      id: 'trial',
      name: 'Trial',
      version: 1,
      features: [
        { id: 'trial_hours', params: { hours: 2 }, text: '2 sandbox hours to try Orca Cloud' }
      ]
    },
    {
      kind: 'self_serve',
      id: 'team',
      name: 'Team',
      version: 1,
      features: [
        {
          id: 'included_hours_per_seat',
          params: { hours: 60 },
          text: '60 sandbox hours per seat each month, pooled across your team'
        },
        {
          id: 'agents_keep_running',
          params: {},
          text: 'Agents keep running when you close your laptop'
        },
        {
          id: 'idle_sleep',
          params: {},
          text: 'Sandboxes sleep when idle, so you only use hours while they work'
        },
        {
          id: 'overage_optional',
          params: {},
          text: 'Optional overage up to a monthly spend cap you set'
        }
      ],
      prices: [
        { interval: 'month', unitAmountCents: 5000, currency: 'usd' },
        { interval: 'year', unitAmountCents: 48000, currency: 'usd' }
      ],
      overage: { centsPerHour: 100, defaultSpendCapCents: 2500, maxSpendCapCents: 500_000 },
      seats: { min: 1, max: 500 },
      includedHoursPerSeat: 60,
      checkoutAvailable: true
    },
    {
      kind: 'contact_sales',
      id: 'enterprise',
      name: 'Enterprise',
      version: 1,
      features: [
        { id: 'byoc', params: {}, text: 'Run sandboxes in your own cloud' },
        { id: 'sso_scim', params: {}, text: 'SSO and SCIM' },
        { id: 'egress_controls', params: {}, text: 'Network egress controls' },
        { id: 'custom_limits', params: {}, text: 'Custom limits and pricing' }
      ],
      contactUrl: 'https://onorca.dev/contact-sales',
      priceLabel: 'Custom'
    }
  ]
}

export const sampleCatalogResult: OrcaPlanCatalogResult = {
  status: 'ok',
  catalog: sampleCatalog,
  source: 'live',
  fetchedAt: Date.UTC(2026, 10, 12)
}

/** The same catalog with only a monthly price on sale (Stripe has no annual price). */
export const monthlyOnlyCatalogResult: OrcaPlanCatalogResult = {
  ...sampleCatalogResult,
  catalog: {
    ...sampleCatalog,
    plans: sampleCatalog.plans.map((plan) =>
      plan.kind === 'self_serve' && 'prices' in plan
        ? { ...plan, prices: plan.prices.filter((price) => price.interval === 'month') }
        : plan
    )
  }
}
