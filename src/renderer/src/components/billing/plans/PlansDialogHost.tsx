import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { OrcaBillingOpenResult } from '../../../../../shared/orca-billing'
import { CheckoutPanel } from '../checkout/CheckoutPanel'
import { useCheckoutFlow } from '../checkout/use-checkout-flow'
import { openFailureCopy } from '../plan-billing-copy'
import type { PlanBillingNotice } from '../PlanBillingSection'
import { returnAfterPaidCheckout } from '../checkout/checkout-return'
import { cancelOrcaCloudAfterCheckout } from '@/lib/orca-cloud-after-checkout'
import { useOrcaBillingStatus } from '../use-orca-billing-status'
import { PlansDialogContent } from './PlansDialogContent'
import { closePlansPage, usePlansPageState } from './plans-page-store'
import { useOrgSeatCount } from './use-org-seat-count'
import { usePlanCatalog } from './use-plan-catalog'
import { resolvePlansModel } from './plans-model'

/**
 * The plans page. A dialog because choosing a plan is a decision step in front of Checkout;
 * it reads billing's plan catalog (GET /v1/plans: Stripe's prices, the catalog's features), so
 * prices and features are never hardcoded here.
 * Checkout itself runs on Stripe's hosted page in the browser; this dialog follows it and,
 * once paid, returns to the Orca Cloud wall that opened it, or hands over to the Team page.
 */
export function PlansDialogHost(): React.JSX.Element {
  const t = useTranslate()
  const { open } = usePlansPageState()
  const billing = useOrcaBillingStatus(open)
  const orgId = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.activeOrgId ?? null)
  const seats = useOrgSeatCount(open ? orgId : null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PlanBillingNotice | null>(null)
  const [orderedAt, setOrderedAt] = useState(0)

  const checkout = useCheckoutFlow({ onPaid: returnAfterPaidCheckout })

  const openPortal = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await window.api.orcaProfiles
      .billingOpenPortal()
      .catch((error: unknown): OrcaBillingOpenResult => ({
        status: 'failed',
        error: String(error)
      }))
    setBusy(false)
    const failure = openFailureCopy(outcome, t)
    setNotice(
      failure
        ? { kind: 'error', text: failure }
        : {
            kind: 'info',
            text: t(
              'auto.components.billing.continueInBrowser',
              'Continue in your browser. This updates when you come back.'
            )
          }
    )
  }

  const catalog = usePlanCatalog(open)
  const plans = resolvePlansModel(catalog.result, billing.result)
  const team = plans.state === 'ready' ? plans.model.team : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          // Closing ends the watch: polling stops and the next open starts from the plans.
          checkout.reset()
          closePlansPage()
          // Leaving without paying: nothing to return to Orca Cloud for.
          cancelOrcaCloudAfterCheckout()
          setNotice(null)
        }
      }}
    >
      {open ? (
        <PlansDialogContent
          result={billing.result}
          catalog={catalog.result}
          busy={busy}
          notice={notice}
          seats={seats}
          onCheckout={({ planId, interval, seats: count }) => {
            setOrderedAt(Date.now())
            checkout.start({ planId, interval, seats: count })
          }}
          onManage={() => void openPortal()}
          onContactSales={(url) => void window.api.shell.openUrl(url)}
          onRetry={() => {
            billing.refresh()
            catalog.refresh()
          }}
          checkoutState={
            checkout.phase.kind === 'paid'
              ? 'paid'
              : checkout.phase.kind === 'canceled'
                ? 'canceled'
                : 'other'
          }
          handingOff={checkout.phase.kind === 'paid'}
          checkout={
            checkout.phase.kind !== 'idle' && team ? (
              <CheckoutPanel
                phase={checkout.phase}
                team={team}
                now={orderedAt}
                onReopen={() => {
                  // Billing couldn't sell the plan: re-read the catalog (and plan state) first.
                  if (
                    checkout.phase.kind === 'open-failed' &&
                    checkout.phase.result.status === 'plan-unavailable'
                  ) {
                    catalog.refresh()
                    billing.refresh()
                  }
                  checkout.reopen()
                }}
                contactUrl={
                  plans.state === 'ready' ? (plans.model.enterprise?.contactUrl ?? null) : null
                }
                onContact={(url) => void window.api.shell.openUrl(url)}
                onKeepWaiting={checkout.keepWaiting}
                onBack={() => {
                  checkout.reset()
                  billing.refresh()
                }}
              />
            ) : undefined
          }
        />
      ) : null}
    </Dialog>
  )
}
