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

/** Learn more for a terminal opened before Orca gave each Codex its own server. */
export function CodexOldTerminalDialog({
  open,
  onOpenChange,
  onOpenNewTerminal
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenNewTerminal: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogTitle',
              'Why this Codex shares a server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'terminal.codexSharedServerBanner.oldTerminalDialogRisk',
              'Codex sessions that share a server can end together, and agent status can be wrong.'
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {translate(
            'terminal.codexSharedServerBanner.oldTerminalDialogCause',
            'Older terminals still share a Codex server. Open a new terminal to run Codex on a separate server.'
          )}
        </p>
        {/* Why no global fix: a new terminal already runs Codex on its own server here. */}
        <DialogFooter>
          <Button type="button" autoFocus onClick={onOpenNewTerminal}>
            {translate('terminal.codexSharedServerBanner.openNewTerminal', 'Open new terminal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
