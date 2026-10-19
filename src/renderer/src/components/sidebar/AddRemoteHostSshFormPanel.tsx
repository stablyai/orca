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
  onFillFromConfig,
  serverLabel
}: {
  form: EditingTarget
  disabled: boolean
  preferAdvancedOpen: boolean
  configIdentityAlias: string | null
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
  onSubmit: () => void
  onCancel: () => void
  /** Absent for a server's host: this client's ~/.ssh/config says nothing about the server's. */
  onFillFromConfig?: () => void
  /** Set when the host is saved on a paired server rather than on this client. */
  serverLabel?: string
}): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {serverLabel
            ? translate(
                'auto.components.sidebar.AddRemoteHostDialog.serverSshTitle',
                'Add SSH host to {{server}}',
                { server: serverLabel }
              )
            : translate('auto.components.sidebar.AddRemoteHostDialog.sshTitle', 'Add SSH host')}
        </DialogTitle>
        <DialogDescription>
          {serverLabel
            ? translate(
                'auto.components.sidebar.AddRemoteHostDialog.serverSshDescription',
                '{{server}} saves this host and connects to it. Passwords and passphrases are asked for when it connects.',
                { server: serverLabel }
              )
            : translate(
                'auto.components.sidebar.AddRemoteHostDialog.sshDescription',
                'Add a persistent machine you can log into over SSH.'
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
        {onFillFromConfig ? (
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
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            {translate('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={disabled}>
            {disabled
              ? translate('auto.components.sidebar.AddRemoteHostDialog.saving', 'Saving...')
              : translate('auto.components.sidebar.AddRemoteHostDialog.save', 'Save')}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
