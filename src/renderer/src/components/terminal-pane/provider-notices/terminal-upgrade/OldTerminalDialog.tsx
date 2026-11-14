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
  const t = useTranslate()
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
            {t('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
