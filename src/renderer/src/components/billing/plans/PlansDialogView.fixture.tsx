import { Dialog } from '@/components/ui/dialog'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  OrcaBillingEntitlement,
  OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import type {
  OrcaPlanCatalog,
  OrcaPlanCatalogResult
} from '../../../../../shared/orca-billing-plans'
import { sampleTeam, sampleTrial } from '../plan-billing-fixtures'
import { PlansDialogView } from './PlansDialogView'

// Shaped like billing-dev's GET /v1/plans after the desktop's parse.
const catalog: OrcaPlanCatalog = {
  catalogVersion: 'c_fixture',
  plans: [
    {
      kind: 'trial',
      id: 'trial',
      name: 'Trial',
      version: 1,
      supportUrl: null,
      marketing: {
        tagline: 'Try Orca Cloud with your team before you pick a plan',
        featuresLead: null,
        ctaLabel: null
      },
      features: [
        { id: 'trial_hours', params: { hours: 2 }, text: '2 sandbox hours to try Orca Cloud' },
        { id: 'no_card', params: {}, text: 'No card needed' }
      ]
    },
    {
      kind: 'self_serve',
      id: 'team',
      name: 'Team',
      version: 2,
      supportUrl: 'https://orca.dev/enterprise',
      marketing: {
        tagline: 'Hosted sandboxes for your whole team, billed per seat',
        featuresLead: null,
        ctaLabel: 'Continue in browser'
      },
      features: [
        {
          id: 'included_hours_per_seat',
          params: { hours: 60 },
          text: '60 sandbox hours per seat each month, pooled across your team'
        },
        { id: 'sandbox_spec', params: {}, text: 'Every sandbox gets 8 vCPU and 16 GB' },
        { id: 'ready_in_seconds', params: {}, text: 'Ready in seconds, nothing to set up or host' },
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
      overage: { centsPerHour: 100, defaultSpendCapCents: 2500, maxSpendCapCents: 500000 },
      seats: { min: 1, max: 500 },
      includedHoursPerSeat: 60,
      checkoutAvailable: true
    },
    {
      kind: 'contact_sales',
      id: 'enterprise',
      name: 'Enterprise',
      version: 2,
      supportUrl: null,
      contactUrl: 'https://orca.dev/enterprise',
      priceLabel: 'Custom',
      marketing: {
        tagline: 'Your cloud, your identity provider, your terms',
        featuresLead: 'Everything in Team, plus:',
        ctaLabel: 'Contact sales'
      },
      features: [
        { id: 'byoc', params: {}, text: 'Run sandboxes in your own cloud' },
        { id: 'sso_scim', params: {}, text: 'SSO and SCIM' },
        { id: 'mfa_enforcement', params: {}, text: 'Require multi-factor authentication' },
        { id: 'audit_log', params: {}, text: 'Team audit log' },
        { id: 'custom_limits', params: {}, text: 'Custom limits and pricing' }
      ]
    }
  ]
}

const live: OrcaPlanCatalogResult = {
  status: 'ok',
  catalog,
  source: 'live',
  fetchedAt: Date.UTC(2026, 10, 14)
}

const noPlan: OrcaBillingEntitlement = {
  ...sampleTeam,
  plan: null,
  planLabel: null,
  status: 'none',
  interval: null,
  seats: 0,
  usageWindow: null,
  includedSeconds: 0,
  usedSeconds: 0,
  remainingIncludedSeconds: 0,
  canStartSandbox: false,
  reason: 'no_subscription',
  offers: { ...sampleTeam.offers!, trial: { includedSeconds: 7200 } }
}

const pastDue: OrcaBillingEntitlement = {
  ...sampleTeam,
  status: 'past_due',
  payment: {
    pastDueSince: Date.UTC(2026, 10, 12),
    graceEndsAt: Date.UTC(2026, 10, 16, 17),
    suspendRunning: false
  },
  canStartSandbox: false,
  reason: 'payment_past_due'
}

function Frame({
  billing,
  plans = live,
  canManage = true
}: {
  billing: OrcaBillingStatusResult | null
  plans?: OrcaPlanCatalogResult | null
  canManage?: boolean
}): React.JSX.Element {
  return (
    <div className="h-[860px]">
      <Dialog open modal={false}>
        <PlansDialogView
          billing={billing}
          catalog={plans}
          canManage={canManage}
          opening={false}
          onContinue={() => {}}
          onContactSales={() => {}}
          onRetry={() => {}}
        />
      </Dialog>
    </div>
  )
}

const ok = (entitlement: OrcaBillingEntitlement): OrcaBillingStatusResult => ({
  status: 'ok',
  entitlement
})

/** Owner or admin, no plan and the trial still on offer. */
export const none = defineFixture({ width: 1280, render: () => <Frame billing={ok(noPlan)} /> })

export const trial = defineFixture({
  width: 1280,
  render: () => <Frame billing={ok(sampleTrial)} />
})

export const active = defineFixture({
  width: 1280,
  render: () => <Frame billing={ok(sampleTeam)} />
})

export const pastDuePlan = defineFixture({
  width: 1280,
  render: () => <Frame billing={ok(pastDue)} />
})

/** A member of a team with no plan: plan info and "Ask a team admin", no buttons into the console. */
export const member = defineFixture({
  width: 1280,
  render: () => <Frame billing={ok({ ...noPlan, canManageBilling: false })} canManage={false} />
})

/** Offline, from main's saved copy of the catalog. */
export const offlineSaved = defineFixture({
  width: 1280,
  render: () => (
    <Frame billing={ok(noPlan)} plans={{ ...live, source: 'cache' } as OrcaPlanCatalogResult} />
  )
})

/** The catalog can't be read: billing's entitlement offers stand in (prices only, no bullets). */
export const fallbackOffers = defineFixture({
  width: 1280,
  render: () => <Frame billing={ok(noPlan)} plans={{ status: 'failed', error: 'offline' }} />
})

/** Neither the catalog nor billing answered: no guessed prices, the console is still offered. */
export const unavailable = defineFixture({
  width: 1280,
  render: () => (
    <Frame
      billing={{ status: 'failed', error: 'offline' }}
      plans={{ status: 'failed', error: 'offline' }}
    />
  )
})

/** Billing hasn't answered yet: a neutral title and skeleton, never an upsell. */
export const loading = defineFixture({
  width: 1280,
  render: () => <Frame billing={null} plans={null} />
})
