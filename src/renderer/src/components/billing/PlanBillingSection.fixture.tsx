import { defineFixture } from '../../component-fixtures/component-fixture'
import { PlanBillingView } from './PlanBillingSection'
import { sampleTeam } from './plan-billing-fixtures'

const HOUR = 3600

const handlers = {
  loading: false,
  busy: false,
  notice: null,
  onRefresh: () => {},
  onPortal: () => {},
  onSetOverage: () => {},
  onSeePlans: () => {}
}

export const activeTeam = defineFixture({
  width: 600,
  render: () => <PlanBillingView {...handlers} result={{ status: 'ok', entitlement: sampleTeam }} />
})

export const noPlan = defineFixture({
  width: 680,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          plan: null,
          planLabel: null,
          status: 'none',
          interval: null,
          seats: 0,
          period: null,
          usageWindow: null,
          includedSeconds: 0,
          usedSeconds: 0,
          remainingIncludedSeconds: 0,
          canStartSandbox: false,
          reason: 'no_subscription'
        }
      }}
    />
  )
})

export const overageCapReached = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          interval: 'year',
          seats: 5,
          includedSeconds: 300 * HOUR,
          usedSeconds: 333 * HOUR,
          remainingIncludedSeconds: 0,
          usageWarningPercent: 100,
          overageSeconds: 33 * HOUR,
          overage: {
            optedIn: true,
            active: true,
            spendCapCents: 2500,
            spentCents: 2500,
            centsPerHour: 100
          },
          canStartSandbox: false,
          reason: 'overage_cap_reached'
        }
      }}
    />
  )
})

export const pastDueMember = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          status: 'past_due',
          usedSeconds: 100 * HOUR,
          remainingIncludedSeconds: 20 * HOUR,
          usageWarningPercent: 80,
          payment: {
            pastDueSince: Date.UTC(2026, 10, 8, 9),
            graceEndsAt: Date.UTC(2026, 10, 12, 9),
            suspendRunning: false
          },
          canStartSandbox: false,
          reason: 'payment_past_due',
          canManageBilling: false
        }
      }}
    />
  )
})

export const suspendedAdmin = defineFixture({
  width: 600,
  render: () => (
    <PlanBillingView
      {...handlers}
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          status: 'past_due',
          payment: {
            pastDueSince: Date.UTC(2026, 10, 3, 9),
            graceEndsAt: Date.UTC(2026, 10, 7, 9),
            suspendRunning: true
          },
          canStartSandbox: false,
          reason: 'payment_grace_expired'
        }
      }}
    />
  )
})
