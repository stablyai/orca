import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

export function MobileRelayServerSwitchDialog({
  open,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  open: boolean
  busy: boolean
  error: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel()
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {t('settings.customRelay.confirmTitle', 'Switch cloud servers?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.customRelay.confirmDescription',
              'This signs you out and disconnects existing mobile relay pairings. Pair those devices again after signing in to the selected server. Local-only pairings are preserved.'
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t(
              'settings.customRelay.error',
              'Could not complete the request. Check the server settings and try again.'
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('settings.customRelay.cancel', 'Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={onConfirm}>
            {busy
              ? t('settings.customRelay.saving', 'Switching servers…')
              : t('settings.customRelay.confirm', 'Switch servers')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
