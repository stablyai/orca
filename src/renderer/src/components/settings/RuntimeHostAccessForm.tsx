import { Loader2, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import {
  translateHostAccessLinkError,
  translateRemotePairingEndpointKind
} from '@/lib/remote-pairing-copy'
import { defaultServerNameForAccessLink } from './runtime-server-default-name'
import {
  RuntimeHostAccessFailureAlert,
  type RuntimeHostAccessFailure
} from './RuntimeHostAccessFailureAlert'

// Why untranslated: a literal shell command.
const HEADLESS_SERVE_COMMAND = 'orca serve --pairing-address <address>'

const NO_TAKEN_NAMES: readonly { name: string }[] = []

type RuntimeHostAccessFormProps = {
  name: string
  /** Names already in use, so the blank-name default shown matches what will be saved. */
  takenNames?: readonly { name: string }[]
  accessLink: string
  busy: boolean
  failure: RuntimeHostAccessFailure | null
  onNameChange: (value: string) => void
  onAccessLinkChange: (value: string) => void
  onCancel: () => void
  onSubmit: (allowLoopback: boolean) => void
}

export function RuntimeHostAccessForm({
  name,
  takenNames = NO_TAKEN_NAMES,
  accessLink,
  busy,
  failure,
  onNameChange,
  onAccessLinkChange,
  onCancel,
  onSubmit
}: RuntimeHostAccessFormProps): React.JSX.Element {
  const [allowLoopback, setAllowLoopback] = useState(false)
  const parsed = useMemo(() => parseHostAccessLink(accessLink), [accessLink])
  const tunnelOverrideEnabled =
    allowLoopback && parsed.ok && parsed.value.endpointKind === 'loopback'
  const loopbackBlocked =
    parsed.ok && parsed.value.endpointKind === 'loopback' && !tunnelOverrideEnabled
  const inputError = accessLink.trim() !== '' && !parsed.ok
  const describedBy = failure
    ? 'runtime-server-verification-error'
    : inputError
      ? 'runtime-server-access-link-error'
      : loopbackBlocked
        ? 'runtime-server-loopback-error'
        : 'runtime-server-access-link-help'
  const canSubmit = parsed.ok && !loopbackBlocked && !busy
  const defaultName = defaultServerNameForAccessLink(accessLink, takenNames)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) {
          onSubmit(tunnelOverrideEnabled)
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="runtime-server-access-link">
          {translate('auto.components.settings.RuntimeHostAccessForm.accessLink', 'Access link')}
        </Label>
        <Input
          id="runtime-server-access-link"
          aria-invalid={inputError || loopbackBlocked || failure !== null}
          aria-describedby={describedBy}
          value={accessLink}
          disabled={busy}
          onChange={(event) => {
            setAllowLoopback(false)
            onAccessLinkChange(event.target.value)
          }}
          placeholder={translate(
            'auto.components.settings.RuntimeHostAccessForm.accessLinkPlaceholder',
            'orca://pair?code=...'
          )}
          className="min-w-0 font-mono"
          autoFocus
        />
        <p id="runtime-server-access-link-help" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeHostAccessForm.accessLinkHelp',
            'Orca shows the destination before connecting. Credentials stay hidden.'
          )}
        </p>
        {inputError ? (
          <p id="runtime-server-access-link-error" className="text-xs text-destructive">
            {parsed.ok ? null : translateHostAccessLinkError(parsed.kind)}
          </p>
        ) : null}
      </div>

      {parsed.ok ? (
        <div className="space-y-1 rounded-md border border-border/60 bg-background/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
            <span>
              {translate(
                'auto.components.settings.RuntimeHostAccessForm.destination',
                'Link destination'
              )}
            </span>
            <Badge variant="outline">
              {translateRemotePairingEndpointKind(parsed.value.endpointKind)}
            </Badge>
          </div>
          <div className="font-mono text-sm" aria-live="polite">
            {parsed.value.displayEndpoint}
          </div>
        </div>
      ) : null}

      {loopbackBlocked && parsed.ok ? (
        <div
          id="runtime-server-loopback-error"
          role="alert"
          className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
        >
          <div className="font-medium text-destructive">
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.loopbackTitle',
              'This link points back to this device'
            )}
          </div>
          <p>
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.loopbackDescription',
              'It uses {{endpoint}}, which points back to the device opening the link—not the other computer that created it.',
              { endpoint: parsed.value.displayEndpoint }
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.loopbackRecoveryTunnel',
              'On the other computer, open Share this computer and create a link for Another device with its Tailscale or LAN address. If you reach it through an SSH tunnel, turn on the option below.'
            )}
          </p>
        </div>
      ) : null}

      {parsed.ok && parsed.value.endpointKind === 'loopback' ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={allowLoopback}
            disabled={busy}
            onCheckedChange={(checked) => setAllowLoopback(checked === true)}
          />
          <span className="space-y-0.5">
            <span className="block">
              {translate(
                'auto.components.settings.RuntimeHostAccessForm.sshTunnelReach',
                'I reach this address through an SSH tunnel'
              )}
            </span>
            <span className="block text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeHostAccessForm.sshTunnelHelp',
                'Keep the tunnel active while using this connection.'
              )}
            </span>
          </span>
        </label>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="runtime-server-name">
          {translate('auto.components.settings.RuntimeHostAccessForm.nameLabel', 'Name')}{' '}
          <span className="font-normal text-muted-foreground">
            {translate('auto.components.settings.RuntimeHostAccessForm.optional', '(optional)')}
          </span>
        </Label>
        <Input
          id="runtime-server-name"
          value={name}
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={
            defaultName ||
            translate(
              'auto.components.settings.RuntimeHostAccessForm.namePlaceholder',
              'Linux workstation'
            )
          }
        />
      </div>

      {failure ? (
        <RuntimeHostAccessFailureAlert
          id="runtime-server-verification-error"
          failure={failure}
          endpoint={parsed.ok ? parsed.value.displayEndpoint : null}
        />
      ) : null}

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.RuntimeHostAccessForm.headlessHelpPrefix',
          'Running Orca without a window? On that computer, run'
        )}{' '}
        <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
          {HEADLESS_SERVE_COMMAND}
        </code>
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.settings.RuntimeHostAccessForm.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {tunnelOverrideEnabled
            ? translate(
                'auto.components.settings.RuntimeHostAccessForm.addServerWithTunnel',
                'Add server using tunnel'
              )
            : translate('auto.components.settings.RuntimeHostAccessForm.addServer', 'Add server')}
        </Button>
      </div>
    </form>
  )
}
