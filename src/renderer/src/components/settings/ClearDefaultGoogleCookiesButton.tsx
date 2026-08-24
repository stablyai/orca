import { toast } from 'sonner'
import { Button } from '../ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function ClearDefaultGoogleCookiesButton(): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const label = translate(
    'auto.components.settings.ClearDefaultGoogleCookiesButton.label',
    'Clear Google cookies'
  )

  return (
    <Button
      variant="ghost"
      size="xs"
      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
      aria-label={label}
      onClick={async () => {
        const confirmed = await confirm({
          title: translate(
            'auto.components.settings.ClearDefaultGoogleCookiesButton.confirmTitle',
            'Clear Google cookies?'
          ),
          description: translate(
            'auto.components.settings.ClearDefaultGoogleCookiesButton.confirmDescription',
            'This signs you out of Google in the default browser profile. Cookies for other sites stay. You can sign in to Google again inside Orca.'
          ),
          confirmLabel: label,
          confirmVariant: 'destructive'
        })
        if (!confirmed) {
          return
        }
        const ok = await useAppStore.getState().clearDefaultGoogleCookies()
        if (ok) {
          toast.success(
            translate(
              'auto.components.settings.ClearDefaultGoogleCookiesButton.cleared',
              'Google cookies cleared.'
            )
          )
          return
        }
        toast.error(
          translate(
            'auto.components.settings.ClearDefaultGoogleCookiesButton.failed',
            'Could not clear Google cookies. Try again.'
          )
        )
      }}
    >
      {label}
    </Button>
  )
}
