import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import {
  translateHostAccessLinkError,
  translateRemotePairingEndpointKind
} from '@/lib/remote-pairing-copy'
import type { ParseHostAccessLinkResult } from '../../../../shared/remote-pairing-address'
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
  parsedLink,
  disabled,
  onNameChange,
  onPairingCodeChange,
  allowLoopback,
  onAllowLoopbackChange,
  onSubmit
}: {
  name: string
  pairingCode: string
  parsedLink: ParseHostAccessLinkResult
  disabled: boolean
  onNameChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  allowLoopback: boolean
  onAllowLoopbackChange: (value: boolean) => void
  onSubmit: () => void
}) {
  const inputError = pairingCode.trim() !== '' && !parsedLink.ok
  const loopbackBlocked =
    parsedLink.ok && parsedLink.value.endpointKind === 'loopback' && !allowLoopback
  const pairingCodeDescriptionId = inputError
    ? 'add-server-pairing-code-error'
    : loopbackBlocked
      ? 'add-server-loopback-blocked'
      : 'add-server-pairing-code-help'
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
          {translate('auto.components.sidebar.AddRemoteHostDialog.serverName', 'Name in Orca')}
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
          {translate('auto.components.sidebar.AddRemoteHostDialog.pairingCode', 'Access link')}
        </Label>
        <Input
          id="add-server-pairing-code"
          aria-invalid={inputError || loopbackBlocked}
          aria-describedby={pairingCodeDescriptionId}
          value={pairingCode}
          disabled={disabled}
          onChange={(event) => onPairingCodeChange(event.target.value)}
          placeholder={translate(
            'auto.components.sidebar.AddRemoteHostDialog.pairingCodePlaceholder',
            'orca://pair?code=...'
          )}
          className="font-mono"
        />
        <p id="add-server-pairing-code-help" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.pairingHelpSuffix',
            'Create this under Settings → Remote Orca Servers → Share this host on the other computer.'
          )}
        </p>
        {inputError ? (
          <p id="add-server-pairing-code-error" role="alert" className="text-xs text-destructive">
            {parsedLink.ok ? null : translateHostAccessLinkError(parsedLink.kind)}
          </p>
        ) : null}
      </div>
      {parsedLink.ok ? (
        <div className="space-y-1 rounded-md border border-border/60 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            {translate(
              'auto.components.sidebar.AddRemoteHostDialog.linkDestination',
              'Link destination'
            )}
            <Badge variant="outline">
              {translateRemotePairingEndpointKind(parsedLink.value.endpointKind)}
            </Badge>
          </div>
          <div className="font-mono text-sm">{parsedLink.value.displayEndpoint}</div>
          {parsedLink.value.endpointKind === 'loopback' ? (
            <label className="mt-2 flex items-start gap-2 text-xs">
              <Checkbox
                checked={allowLoopback}
                disabled={disabled}
                onCheckedChange={(checked) => onAllowLoopbackChange(checked === true)}
              />
              <span>
                <span className="block font-medium">
                  {translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshTunnel',
                    'I am using an SSH tunnel'
                  )}
                </span>
                <span className="text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshTunnelHelp',
                    'Otherwise, this link points back to this device and cannot identify the other computer.'
                  )}
                </span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
      {loopbackBlocked ? (
        <p id="add-server-loopback-blocked" role="alert" className="text-xs text-destructive">
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.loopbackBlocked',
            'Enable the SSH tunnel override or create a new link using the other host’s Tailscale or LAN address.'
          )}
        </p>
      ) : null}
    </form>
  )
}
