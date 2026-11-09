import type { SshTarget } from '../../../../../../shared/ssh-types'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'

/** Main refuses to remove a host its managed server still holds; only Stop or Forget frees it. */
export function isManagedServerSshHost(
  target: Pick<SshTarget, 'orcadFence' | 'orcadProvisioning'>
): boolean {
  return target.orcadFence !== undefined || target.orcadProvisioning !== undefined
}

export function SshManagedHostRemoveDialog({
  label,
  onClose
}: {
  label: string | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
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
            {t(
              'auto.components.settings.SshTargetDestructiveActions.4808966c41',
              'Remove SSH Target'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.sshManagedHostRemove.descriptionServerHost',
              'Orca runs on {{label}}. In Remote Orca Servers, open the ⋯ menu on {{label}} and choose Stop… to remove Orca from the host, or Forget… if the host is gone. Then you can remove this SSH host.',
              { label: label ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('auto.components.settings.SshDestructiveActionDialog.895b216267', 'Cancel')}
          </Button>
          <Button onClick={openManagedServers}>
            {t(
              'auto.components.settings.sshManagedHostRemove.openServers',
              'Open Remote Orca Servers'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
