import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export function OrcaProfileSignOutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  profileName,
  signingOut
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  profileName: string
  signingOut: boolean
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            {translate('auto.components.orca.profiles.signout.confirm.title', 'Sign out?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.orca.profiles.signout.confirm.description',
              'Sign out of {{profileName}} and keep its projects, worktrees, and local metadata on this device.',
              { profileName }
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
            {translate('auto.components.orca.profiles.signout.confirm.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={signingOut}>
            {signingOut ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.orca.profiles.signout.confirm.action', 'Sign out')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
