import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'

type CliRegistrationDialogProps = {
  busyAction: 'install' | 'remove' | null
  commandName: string
  commandPath: string | null | undefined
  isEnabled: boolean
  isSupported: boolean
  onInstall: () => Promise<void>
  onOpenChange: (open: boolean) => void
  onRemove: () => Promise<void>
  open: boolean
}

export function CliRegistrationDialog({
  busyAction,
  commandName,
  commandPath,
  isEnabled,
  isSupported,
  onInstall,
  onOpenChange,
  onRemove,
  open
}: CliRegistrationDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEnabled
              ? translate(
                  'auto.components.settings.CliSection.14444243ba',
                  'Remove `{{value0}}` from PATH?',
                  { value0: commandName }
                )
              : translate(
                  'auto.components.settings.CliSection.fa87db3d6e',
                  'Register `{{value0}}` in PATH?',
                  { value0: commandName }
                )}
          </DialogTitle>
          <DialogDescription>
            {isEnabled
              ? translate(
                  'auto.components.settings.CliSection.a030816e3e',
                  'This removes the shell command symlink. Orca itself remains installed.'
                )
              : translate(
                  'auto.components.settings.CliSection.aa6536977e',
                  'Orca will register {{value0}} so the command works from your terminal.',
                  { value0: commandPath ?? commandName }
                )}
          </DialogDescription>
        </DialogHeader>
        {commandPath ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.CliSection.a4aafe46e3', 'Target path:')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{commandPath}</code>
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busyAction !== null}
          >
            {translate('auto.components.settings.CliSection.8671e406f0', 'Cancel')}
          </Button>
          <Button
            onClick={() => void (isEnabled ? onRemove() : onInstall())}
            disabled={busyAction !== null || !isSupported}
          >
            {busyAction === 'remove'
              ? translate('auto.components.settings.CliSection.068552b191', 'Removing…')
              : busyAction === 'install'
                ? translate('auto.components.settings.CliSection.b0fca411a0', 'Registering…')
                : isEnabled
                  ? translate('auto.components.settings.CliSection.9a5f8a4568', 'Remove')
                  : translate('auto.components.settings.CliSection.d00df2e397', 'Register')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
