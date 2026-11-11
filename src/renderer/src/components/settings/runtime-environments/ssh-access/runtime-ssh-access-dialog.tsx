import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { SshTarget } from '../../../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../../../preload/api/managed-orcad-api'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { RuntimeSshAccessControl } from './RuntimeSshAccessControl'

export function RuntimeSshAccessDialog({
  open,
  api,
  environment,
  targets,
  onOpenChange,
  onChanged
}: {
  open: boolean
  api: Pick<ManagedOrcadPreloadApi, 'linkSshAccess' | 'unlinkSshAccess'>
  environment: PublicKnownRuntimeEnvironment
  targets: SshTarget[]
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              'auto.components.settings.serverList.sshDialogTitle',
              'Connect {{name}} through SSH',
              { name: environment.name }
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.serverList.sshDialogDescription',
              'Use this when the server isn’t reachable directly. Orca opens a tunnel through an SSH host.'
            )}
          </DialogDescription>
        </DialogHeader>
        <RuntimeSshAccessControl
          api={api}
          environment={environment}
          targets={targets}
          onChanged={() => {
            onChanged()
            onOpenChange(false)
          }}
          footerStart={
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('auto.components.settings.serverList.cancel', 'Cancel')}
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
