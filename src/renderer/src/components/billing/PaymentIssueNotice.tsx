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
          {t('auto.components.billing.paymentFailed', 'Payment failed')}
        </p>
        <p className="text-xs text-muted-foreground">
          {payment.suspendRunning || payment.graceEndsAt === null
            ? t(
                'auto.components.billing.paymentAsleepBody',
                'New sandboxes can’t start and running sandboxes are asleep. They can wake again once the payment goes through. Your files are safe.'
              )
            : t(
                'auto.components.billing.paymentGraceBody2',
                'New sandboxes can’t start. Running sandboxes go to sleep on {{value0}} unless the payment goes through.',
                { value0: when(payment.graceEndsAt) }
              )}
        </p>
        {entitlement.canManageBilling ? (
          <Button
            type="button"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onUpdatePayment}
            data-plans-primary=""
          >
            {t('auto.components.billing.updatePayment', 'Update payment method')}
            <ExternalLink />
          </Button>
        ) : (
          <p className="text-xs font-medium">
            {t(
              'auto.components.billing.paymentAskAdmin',
              'Ask an owner or admin to update the payment method.'
            )}
          </p>
        )}
      </div>
    </div>
  )
}
