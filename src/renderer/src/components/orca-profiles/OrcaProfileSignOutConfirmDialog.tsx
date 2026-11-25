import { Loader2 } from 'lucide-react'
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

export function OrcaProfileSignOutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  signingOut,
  returnFocusRef
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  signingOut: boolean
  /** Where focus goes when the dialog closes, for a dialog opened from a menu row rather than its own trigger. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[420px]"
        onCloseAutoFocus={
          returnFocusRef
            ? (event) => {
                event.preventDefault()
                returnFocusRef.current?.focus({ preventScroll: true })
              }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.orca.profiles.signout.confirm.title', 'Sign out of Orca?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.orca.profiles.signout.confirm.description',
              "Artifacts and Orca Relay will be unavailable until you sign in again. Your local projects and worktrees won't be affected."
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={signingOut}
          >
            {t('auto.components.orca.profiles.signout.confirm.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={signingOut}>
            {signingOut ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('auto.components.orca.profiles.signout.confirm.action', 'Sign out')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
