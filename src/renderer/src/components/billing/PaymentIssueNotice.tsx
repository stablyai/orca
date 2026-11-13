import { ExternalLink } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { billingPortalLink } from './billing-link'
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
  const body =
    payment.suspendRunning || payment.graceEndsAt === null
      ? t(
          'auto.components.billing.paymentAsleepBody',
          'New sandboxes can’t start and running sandboxes are asleep. They can wake again once the payment goes through. Your files are safe.'
        )
      : t(
          'auto.components.billing.paymentGraceBody2',
          'New sandboxes can’t start. Running sandboxes go to sleep on {{value0}} unless the payment goes through.',
          { value0: when(payment.graceEndsAt) }
        )
  return (
    <InlineError
      tone="error"
      title={t('auto.components.billing.paymentFailed', 'Payment failed')}
      detail={
        entitlement.canManageBilling ? (
          body
        ) : (
          <>
            {body}{' '}
            {t(
              'auto.components.billing.paymentAskAdmin',
              'Ask an owner or admin to update the payment method.'
            )}
          </>
        )
      }
      action={
        entitlement.canManageBilling ? (
          <OpenExternalSplitButton
            variant="outline"
            size="xs"
            aria-disabled={busy || undefined}
            link={billingPortalLink}
            onClick={() => {
              if (!busy) {
                onUpdatePayment()
              }
            }}
          >
            {t('auto.components.billing.updatePayment', 'Update payment method')}
            <ExternalLink />
          </OpenExternalSplitButton>
        ) : undefined
      }
    />
  )
}
