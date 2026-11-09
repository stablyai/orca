import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingOpenResult } from '../../../../../shared/orca-billing'
import { openFailureCopy } from '../plan-billing-copy'
import { useOrcaBillingStatus } from '../use-orca-billing-status'
import { PlansDialogContent } from './PlansDialogContent'
import { closePlansPage, usePlansPageState } from './plans-page-store'
import { useOrgSeatCount } from './use-org-seat-count'
import { useAppStore } from '@/store/index'

/**
 * The plans page. A dialog because choosing a plan is a decision step in front of Checkout;
 * it reads the billing service's offers, so prices and limits are never hardcoded here.
 */
export function PlansDialogHost(): React.JSX.Element {
  const t = useTranslate()
  const { open } = usePlansPageState()
  const billing = useOrcaBillingStatus(open)
  const orgId = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.activeOrgId ?? null)
  const seats = useOrgSeatCount(open ? orgId : null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (action: () => Promise<OrcaBillingOpenResult>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await action().catch((error: unknown): OrcaBillingOpenResult => ({
      status: 'failed',
      error: String(error)
    }))
    setBusy(false)
    setNotice(
      outcome.status === 'opened'
        ? t(
            'auto.components.billing.continueInBrowser',
            'Continue in your browser. This updates when you come back.'
          )
        : openFailureCopy(outcome, t)
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closePlansPage()
          setNotice(null)
        }
      }}
    >
      {open ? (
        <PlansDialogContent
          // Remount once the status arrives so the interval starts fresh.
          key={billing.result ? 'ready' : 'loading'}
          result={billing.result}
          busy={busy}
          notice={notice}
          seats={seats}
          onCheckout={({ interval, seats: count }) =>
            void run(() =>
              window.api.orcaProfiles.billingOpenCheckout({ plan: 'team', interval, seats: count })
            )
          }
          onManage={() => void run(() => window.api.orcaProfiles.billingOpenPortal())}
          onContactSales={(url) => void window.api.shell.openUrl(url)}
          onRetry={billing.refresh}
        />
      ) : null}
    </Dialog>
  )
}
