import { defineFixture } from '../../component-fixtures/component-fixture'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { PlanBillingView } from './PlanBillingSection'

const HOUR = 3600
const periodEnd = Date.UTC(2026, 11, 3)

const pro: OrcaBillingEntitlement = {
  plan: 'pro',
  planLabel: 'Pro',
  status: 'active',
  seats: 1,
  period: { start: Date.UTC(2026, 10, 3), end: periodEnd },
  cancelAtPeriodEnd: false,
  includedSeconds: 50 * HOUR,
  usedSeconds: 18.5 * HOUR,
  remainingIncludedSeconds: 31.5 * HOUR,
  overageSeconds: 0,
  overageEnabled: true,
  overageCapSeconds: 100 * HOUR,
  canStartSandbox: true,
  reason: null,
  canManageBilling: true
}

const handlers = {
  loading: false,
  busy: false,
  onRefresh: () => {},
  onCheckout: () => {},
  onPortal: () => {}
}

export const activePro = defineFixture({
  width: 560,
  render: () => (
    <PlanBillingView {...handlers} notice={null} result={{ status: 'ok', entitlement: pro }} />
  )
})

export const noPlan = defineFixture({
  width: 640,
  render: () => (
    <PlanBillingView
      {...handlers}
      notice={null}
      result={{
        status: 'ok',
        entitlement: {
          ...pro,
          plan: null,
          planLabel: null,
          status: 'none',
          period: null,
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

export const teamPastDueMember = defineFixture({
  width: 560,
  render: () => (
    <PlanBillingView
      {...handlers}
      notice={null}
      result={{
        status: 'ok',
        entitlement: {
          ...pro,
          plan: 'team',
          planLabel: 'Team',
          status: 'past_due',
          seats: 4,
          includedSeconds: 600 * HOUR,
          usedSeconds: 640 * HOUR,
          remainingIncludedSeconds: 0,
          overageSeconds: 40 * HOUR,
          canStartSandbox: false,
          reason: 'payment_past_due',
          canManageBilling: false
        }
      }}
    />
  )
})
