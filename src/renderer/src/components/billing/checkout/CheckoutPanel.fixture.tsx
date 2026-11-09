import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Dialog } from '@/components/ui/dialog'
import { sampleOffers, sampleTeam } from '../plan-billing-fixtures'
import { PlansDialogContent } from '../plans/PlansDialogContent'
import { CheckoutPanel, type CheckoutPanelProps } from './CheckoutPanel'

const NOW = Date.UTC(2026, 10, 18, 15)
const order = { interval: 'month' as const, seats: 3 }
const width = 1280

function Page({ phase }: { phase: CheckoutPanelProps['phase'] }): React.JSX.Element {
  return (
    <Dialog open modal={false}>
      <PlansDialogContent
        result={{ status: 'ok', entitlement: sampleTeam }}
        busy={false}
        notice={null}
        seats={3}
        onCheckout={() => {}}
        onManage={() => {}}
        onContactSales={() => {}}
        onRetry={() => {}}
        checkout={
          <CheckoutPanel
            phase={phase}
            team={sampleOffers.team}
            now={NOW}
            onReopen={() => {}}
            onKeepWaiting={() => {}}
            onBack={() => {}}
          />
        }
      />
    </Dialog>
  )
}

export const opening = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'opening', order }} />
})
export const awaitingPayment = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'awaiting-payment', order, since: NOW }} />
})
export const paid = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'paid', order, seats: 3 }} />
})
export const canceled = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'canceled', order }} />
})
export const needsAttention = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'needs-attention', order }} />
})
export const timedOut = defineFixture({
  width,
  render: () => <Page phase={{ kind: 'timed-out', order }} />
})
export const openFailed = defineFixture({
  width,
  render: () => (
    <Page phase={{ kind: 'open-failed', order, result: { status: 'failed', error: 'timeout' } }} />
  )
})
export const annual = defineFixture({
  width,
  render: () => (
    <Page phase={{ kind: 'awaiting-payment', order: { interval: 'year', seats: 5 }, since: NOW }} />
  )
})
