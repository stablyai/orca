import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { EditingTarget } from '../settings/ssh-target-draft'
import { SshHostFields } from './AddRemoteHostFields'

export function AddRemoteHostSshFormPanel({
  form,
  disabled,
  preferAdvancedOpen,
  configIdentityAlias,
  onFormChange,
  onSubmit,
  onCancel,
  onFillFromConfig
}: {
  form: EditingTarget
  disabled: boolean
  preferAdvancedOpen: boolean
  configIdentityAlias: string | null
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
  onSubmit: () => void
  onCancel: () => void
  onFillFromConfig: () => void
}): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.sidebar.AddRemoteHostDialog.sshTitle', 'Add SSH host')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshServerDescription',
            'Install an Orca server over SSH. No Node.js installation is needed on the host.'
          )}
        </DialogDescription>
      </DialogHeader>

      <SshHostFields
        form={form}
        disabled={disabled}
        preferAdvancedOpen={preferAdvancedOpen}
        configIdentityAlias={configIdentityAlias}
        onFormChange={onFormChange}
        onSubmit={onSubmit}
      />

      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="link"
          className="h-auto self-center justify-start p-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={onFillFromConfig}
          disabled={disabled}
        >
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.fillFromSshConfig',
            'Fill from ~/.ssh/config…'
          )}
        </Button>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            {translate('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" className="w-36" onClick={onSubmit} disabled={disabled}>
            {disabled
              ? translate(
                  'auto.components.sidebar.AddRemoteHostDialog.provisioning',
                  'Setting up server…'
                )
              : translate(
                  'auto.components.sidebar.AddRemoteHostDialog.installServer',
                  'Install server'
                )}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
