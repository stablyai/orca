import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { applyParsedSshHostInput, type EditingTarget } from '../settings/ssh-target-draft'
import { SshHostAdvancedFields } from '../settings/SshHostAdvancedFields'

export function SshHostFields({
  form,
  disabled,
  onFormChange,
  onSubmit
}: {
  form: EditingTarget
  disabled: boolean
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
  onSubmit: () => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="add-ssh-label">
          {translate('auto.components.sidebar.AddRemoteHostDialog.label', 'Label')}
        </Label>
        <Input
          id="add-ssh-label"
          value={form.label}
          disabled={disabled}
          onChange={(event) => onFormChange((draft) => ({ ...draft, label: event.target.value }))}
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshLabelPlaceholder',
            'Dev box'
          )}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="add-ssh-host">
          {translate('auto.components.sidebar.AddRemoteHostDialog.sshHost', 'Host or alias')}
        </Label>
        <Input
          id="add-ssh-host"
          value={form.host}
          disabled={disabled}
          autoFocus
          onBlur={() => onFormChange(applyParsedSshHostInput)}
          onChange={(event) => onFormChange((draft) => ({ ...draft, host: event.target.value }))}
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshHostPlaceholder',
            'deploy@server:22'
          )}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="add-ssh-username">
          {translate('auto.components.sidebar.AddRemoteHostDialog.username', 'Username')}
        </Label>
        <Input
          id="add-ssh-username"
          value={form.username}
          disabled={disabled}
          onChange={(event) =>
            onFormChange((draft) => ({ ...draft, username: event.target.value }))
          }
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.usernamePlaceholder',
            'deploy'
          )}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="add-ssh-port">
          {translate('auto.components.sidebar.AddRemoteHostDialog.port', 'Port')}
        </Label>
        <Input
          id="add-ssh-port"
          value={form.port}
          disabled={disabled}
          type="number"
          min={1}
          max={65535}
          onChange={(event) => onFormChange((draft) => ({ ...draft, port: event.target.value }))}
          placeholder="22"
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="add-ssh-identity-file">
          {translate('auto.components.sidebar.AddRemoteHostDialog.identityFile', 'Identity file')}
        </Label>
        <Input
          id="add-ssh-identity-file"
          value={form.identityFile}
          disabled={disabled}
          onChange={(event) =>
            onFormChange((draft) => ({ ...draft, identityFile: event.target.value }))
          }
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.identityFilePlaceholder',
            '~/.ssh/id_ed25519 (optional)'
          )}
        />
      </div>
      <SshHostAdvancedFields
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        form={form}
        disabled={disabled}
        onFormChange={onFormChange}
      />
    </form>
  )
}

export function RemoteServerFields({
  name,
  pairingCode,
  disabled,
  onNameChange,
  onPairingCodeChange,
  onSubmit
}: {
  name: string
  pairingCode: string
  disabled: boolean
  onNameChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="add-server-name">
          {translate('auto.components.sidebar.AddRemoteHostDialog.serverName', 'Server name')}
        </Label>
        <Input
          id="add-server-name"
          value={name}
          disabled={disabled}
          autoFocus
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.serverNamePlaceholder',
            'Dev box'
          )}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="add-server-pairing-code">
          {translate('auto.components.sidebar.AddRemoteHostDialog.pairingCode', 'Pairing code')}
        </Label>
        <Input
          id="add-server-pairing-code"
          value={pairingCode}
          disabled={disabled}
          onChange={(event) => onPairingCodeChange(event.target.value)}
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.pairingCodePlaceholder',
            'orca://pair?code=...'
          )}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.sidebar.AddRemoteHostDialog.pairingHelpPrefix', 'Run')}{' '}
          <span className="font-mono">
            {translate(
              'auto.components.sidebar.AddRemoteHostDialog.pairingCommand',
              'orca serve --pairing-address <host>'
            )}
          </span>{' '}
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.pairingHelpSuffix',
            'on the server and paste the printed pairing URL.'
          )}
        </p>
      </div>
    </form>
  )
}
