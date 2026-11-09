import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { sampleTeam } from '../plan-billing-fixtures'
import { Dialog } from '@/components/ui/dialog'
import { PlansDialogContent } from './PlansDialogContent'
import type { PlansViewProps } from './PlansView'

const HOUR = 3600

const handlers = {
  busy: false,
  notice: null,
  seats: 4,
  onCheckout: () => {},
  onManage: () => {},
  onContactSales: () => {},
  onRetry: () => {}
}

const noPlan: OrcaBillingEntitlement = {
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

const width = 1280

function Page(props: Pick<PlansViewProps, 'result'> & Partial<PlansViewProps>): React.JSX.Element {
  return (
    <Dialog open modal={false}>
      <PlansDialogContent {...handlers} {...props} />
    </Dialog>
  )
}

export const choosePlan = defineFixture({
  width,
  render: () => <Page result={{ status: 'ok', entitlement: noPlan }} />
})

export const memberCannotBuy = defineFixture({
  width,
  render: () => (
    <Page result={{ status: 'ok', entitlement: { ...noPlan, canManageBilling: false } }} />
  )
})

export const currentPlan = defineFixture({
  width,
  render: () => (
    <Page
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          interval: 'year',
          seats: 4,
          includedSeconds: 240 * HOUR,
          usedSeconds: 96 * HOUR,
          remainingIncludedSeconds: 144 * HOUR
        }
      }}
    />
  )
})

export const paymentFailed = defineFixture({
  width,
  render: () => (
    <Page
      result={{
        status: 'ok',
        entitlement: {
          ...sampleTeam,
          status: 'past_due',
          payment: {
            pastDueSince: Date.UTC(2026, 10, 8, 9),
            graceEndsAt: Date.UTC(2026, 10, 12, 9),
            suspendRunning: false
          },
          canStartSandbox: false,
          reason: 'payment_past_due'
        }
      }}
    />
  )
})

export const loading = defineFixture({
  width,
  render: () => <Page result={null} />
})

export const loadFailed = defineFixture({
  width,
  render: () => <Page result={{ status: 'failed', error: 'timeout' }} />
})
