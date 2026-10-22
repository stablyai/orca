import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.serverList.sshDialogTitle',
              'Connect {{name}} through SSH',
              { name: environment.name }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
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
              {translate('auto.components.settings.serverList.cancel', 'Cancel')}
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
