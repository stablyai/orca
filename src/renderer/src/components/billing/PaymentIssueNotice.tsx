import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'

/**
 * Failed renewal: new sandboxes are paused at once; running ones are suspended when the grace
 * ends. Stripe keeps retrying the card and emails the billing contact meanwhile.
 */
export function PaymentIssueNotice({
  entitlement,
  busy,
  onUpdatePayment
}: {
  entitlement: OrcaBillingEntitlement
  busy: boolean
  onUpdatePayment: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { payment } = entitlement
  if (payment.pastDueSince === null) {
    return null
  }
  const when = (ms: number): string =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(ms)
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-destructive/40 p-3"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">
          {payment.suspendRunning
            ? t('auto.components.billing.paymentSuspended', 'Sandboxes suspended: payment overdue')
            : t('auto.components.billing.paymentFailed', 'Payment failed')}
        </p>
        <p className="text-xs text-muted-foreground">
          {payment.suspendRunning || payment.graceEndsAt === null
            ? t(
                'auto.components.billing.paymentSuspendedBody',
                'Running sandboxes were suspended and new ones cannot start. Update your payment method; everything resumes once the invoice is paid.'
              )
            : t(
                'auto.components.billing.paymentGraceBody',
                'New sandboxes are paused. Running sandboxes will be suspended on {{value0}} unless the payment goes through. Stripe will retry the card and email your billing contact.',
                { value0: when(payment.graceEndsAt) }
              )}
        </p>
        {entitlement.canManageBilling ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onUpdatePayment}
          >
            {t('auto.components.billing.updatePayment', 'Update payment method')}
            <ExternalLink />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
