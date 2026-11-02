import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

/** Main refuses to remove a host its managed server still holds; only Stop or Forget frees it. */
export function isManagedServerSshHost(
  target: Pick<SshTarget, 'orcadFence' | 'orcadProvisioning'>
): boolean {
  return target.orcadFence !== undefined || target.orcadProvisioning !== undefined
}

/** Sends a managed server's host to Managed servers instead of a removal main would refuse. */
export function SshManagedHostRemoveDialog({
  label,
  onClose
}: {
  label: string | null
  onClose: () => void
}): React.JSX.Element {
  const openManagedServers = (): void => {
    useAppStore
      .getState()
      .openSettingsTarget({ pane: 'servers', repoId: null, sectionId: 'managed-servers' })
    onClose()
  }
  return (
    <Dialog open={label !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.SshTargetDestructiveActions.4808966c41',
              'Remove SSH Target'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.sshManagedHostRemove.description',
              '{{label}} runs a managed Orca server. Under Managed servers, use Stop… to remove the server from the host, or Forget… if the host is gone. Then you can remove this SSH host.',
              { label: label ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('auto.components.settings.SshDestructiveActionDialog.895b216267', 'Cancel')}
          </Button>
          <Button onClick={openManagedServers}>
            {translate(
              'auto.components.settings.sshManagedHostRemove.open',
              'Open Managed servers'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
