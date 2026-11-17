import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'

export function OrcaProfileSignOutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  signingOut
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  signingOut: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm" busy={signingOut}>
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.orca.profiles.signout.confirm.title', 'Sign out of Orca?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.orca.profiles.signout.confirm.description2',
              "You'll lose access to your cloud workspaces until you sign in again. Local workspaces aren't affected."
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogCancel>
            {t('auto.components.orca.profiles.signout.confirm.cancel', 'Cancel')}
          </DialogCancel>
          <Button size="sm" onClick={onConfirm} disabled={signingOut}>
            {signingOut
              ? t('auto.components.orca.profiles.signout.confirm.signingOut', 'Signing out…')
              : t('auto.components.orca.profiles.signout.confirm.action', 'Sign out')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
