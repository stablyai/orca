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

/** Learn more for a terminal opened before an Orca update its shell does not have. */
export function OldTerminalDialog({
  open,
  onOpenChange,
  onOpenNewTerminal,
  title,
  description,
  cause
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenNewTerminal: () => void
  title: string
  description: string
  cause: string
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{cause}</p>
        {/* Why no global fix: a new terminal already has the update. */}
        <DialogFooter>
          <Button type="button" autoFocus onClick={onOpenNewTerminal}>
            {translate('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
