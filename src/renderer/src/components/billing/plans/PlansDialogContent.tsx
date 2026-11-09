import type { ReactNode } from 'react'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { PlansView, isSubscribed, type PlansViewProps } from './PlansView'

/**
 * The plans page surface: heading plus plans, or the checkout panel while Checkout runs.
 * Top-anchored so loading, plans and checkout never make the dialog jump (review M4).
 */
export function PlansDialogContent(
  props: PlansViewProps & { checkout?: ReactNode }
): React.JSX.Element {
  const t = useTranslate()
  const subscribed = isSubscribed(props.result)
  const { checkout, ...viewProps } = props
  return (
    <DialogContent
      scrollable
      className="top-[6vh] max-h-[88vh] translate-y-0 sm:max-w-4xl [@media(max-height:800px)]:top-4 [@media(max-height:800px)]:max-h-[calc(100vh-2rem)]"
      onOpenAutoFocus={(event) => {
        // Land on the primary action for this state when it is already rendered (review P1-13);
        // otherwise on the dialog itself so nothing looks pre-selected.
        event.preventDefault()
        if (event.currentTarget instanceof HTMLElement) {
          const primary = event.currentTarget.querySelector<HTMLElement>('[data-plans-primary]')
          ;(primary ?? event.currentTarget).focus({ focusVisible: false } as FocusOptions)
        }
      }}
    >
      <DialogHeader className="items-center text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('auto.components.billing.plans.eyebrow', 'Orca Cloud')}
        </p>
        <DialogTitle size="display">
          {checkout
            ? t('auto.components.billing.checkout.title', 'Checkout')
            : subscribed
              ? t('auto.components.billing.plans.titleSubscribed', 'Your Orca Cloud plan')
              : t('auto.components.billing.plans.title', 'Cloud sandboxes for your whole team')}
        </DialogTitle>
        <DialogDescription
          className={subscribed || checkout ? 'sr-only' : 'mx-auto max-w-xl text-center'}
        >
          {checkout
            ? t(
                'auto.components.billing.checkout.subtitle',
                'Pay on Stripe’s secure page in your browser. Orca picks it up the moment it goes through.'
              )
            : subscribed
              ? t(
                  'auto.components.billing.plans.subtitleSubscribed',
                  'Usage this month, your plan, and what Enterprise adds.'
                )
              : t(
                  'auto.components.billing.plans.subtitle2',
                  'Run Orca agents in hosted sandboxes that keep going when you step away.'
                )}
        </DialogDescription>
      </DialogHeader>
      {checkout ?? <PlansView {...viewProps} />}
    </DialogContent>
  )
}
