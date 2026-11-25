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

/** Restarting an SSH-started server as a WSL host ends what runs on it, so the user confirms. */
export function WslHostRestartAsWslHostDialog({
  hostName,
  onOpenChange,
  onConfirm
}: {
  /** The host to restart; null keeps the dialog closed. */
  hostName: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={hostName !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.wslHosts.restartAsWslHost.title', 'Restart as WSL host?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.wslHosts.restartAsWslHost.description',
              'This ends every terminal and agent running on {{host}}, including ones an SSH host opened there. Orca then starts its server again as a WSL host, so projects can move to it.',
              { host: hostName ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('auto.components.settings.wslHosts.restartAsWslHost.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t(
              'auto.components.settings.wslHosts.restartAsWslHost.action',
              'End terminals and restart'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
