import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { PlansView, isSubscribed, type PlansViewProps } from './PlansView'

/** The plans page surface: heading plus plans. Rendered inside a <Dialog>. */
export function PlansDialogContent(props: PlansViewProps): React.JSX.Element {
  const t = useTranslate()
  const subscribed = isSubscribed(props.result)
  return (
    <DialogContent
      scrollable
      className="sm:max-w-4xl"
      // Focus the dialog itself so no button looks pre-selected; Tab reaches the actions.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.focus()
        }
      }}
    >
      <DialogHeader className="items-center text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('auto.components.billing.plans.eyebrow', 'Orca Cloud')}
        </p>
        <DialogTitle size="display">
          {subscribed
            ? t('auto.components.billing.plans.titleSubscribed', 'Your Orca Cloud plan')
            : t('auto.components.billing.plans.title', 'Cloud sandboxes for your whole team')}
        </DialogTitle>
        <DialogDescription className="max-w-xl">
          {subscribed
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
      <PlansView {...props} />
    </DialogContent>
  )
}
