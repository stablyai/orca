import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import type { RemotePairingFailureKind } from '../../../../shared/remote-pairing-verification'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import {
  translateHostAccessLinkError,
  translateRemotePairingEndpointKind,
  translateRemotePairingFailureDescription
} from '@/lib/remote-pairing-copy'

export type RuntimeHostAccessFailure = {
  kind: RemotePairingFailureKind
  message: string
}

type RuntimeHostAccessFormProps = {
  name: string
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
  const canSubmit = name.trim() !== '' && parsed.ok && !loopbackBlocked && !busy

  return (
    <form
      className="space-y-4 rounded-lg border border-border/50 bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) {
          onSubmit(tunnelOverrideEnabled)
        }
      }}
    >
      <div className="space-y-2 rounded-md border border-border/60 bg-background/60 p-3">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.settings.RuntimeHostAccessForm.getLink',
            'Get an access link from the other host'
          )}
        </div>
        <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
          <li>
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.stepOpenShare',
              'Open Settings → Remote Orca Servers → Share this host.'
            )}
          </li>
          <li>
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.stepChooseAddress',
              'Choose Another device and select a reachable address.'
            )}
          </li>
          <li>
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.stepCopyLink',
              'Generate the link, then copy the “Pair another Orca client” link.'
            )}
          </li>
        </ol>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
        <div className="space-y-2">
          <Label htmlFor="runtime-server-name">
            {translate('auto.components.settings.RuntimeHostAccessForm.name', 'Name in Orca')}
          </Label>
          <Input
            id="runtime-server-name"
            value={name}
            disabled={busy}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={translate(
              'auto.components.settings.RuntimeHostAccessForm.namePlaceholder',
              'Linux workstation'
            )}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.nameHelp',
              'This only changes how the computer appears in Orca.'
            )}
          </p>
        </div>
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
              'auto.components.settings.RuntimeHostAccessForm.loopbackRecovery',
              'On the other computer, create a new link using Another device and choose its Tailscale or LAN address.'
            )}
          </p>
          <details className="pt-1 text-xs">
            <summary className="cursor-pointer font-medium">
              {translate(
                'auto.components.settings.RuntimeHostAccessForm.connectionDetails',
                'Connection details'
              )}
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.destination',
                  'Link destination'
                )}
              </dt>
              <dd className="font-mono text-foreground">{parsed.value.displayEndpoint}</dd>
              <dt>
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.endpointKind',
                  'Endpoint kind'
                )}
              </dt>
              <dd className="text-foreground">
                {translateRemotePairingEndpointKind(parsed.value.endpointKind)}
              </dd>
              <dt>
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.networkConnection',
                  'Network connection'
                )}
              </dt>
              <dd className="text-foreground">
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.notAttempted',
                  'Not attempted'
                )}
              </dd>
            </dl>
          </details>
        </div>
      ) : null}

      {failure ? (
        <div
          id="runtime-server-verification-error"
          role="alert"
          className="space-y-1 rounded-md border border-destructive/50 p-3"
        >
          <div className="text-sm font-medium text-destructive">
            {failure.kind === 'host-identity-mismatch'
              ? translate(
                  'auto.components.settings.RuntimeHostAccessForm.identityMismatch',
                  'The reached Orca host does not match this access link'
                )
              : failure.kind === 'access-link-invalid'
                ? translate(
                    'auto.components.settings.RuntimeHostAccessForm.invalidLink',
                    'This access link is no longer valid'
                  )
                : failure.kind === 'protocol-incompatible'
                  ? translate(
                      'auto.components.settings.RuntimeHostAccessForm.incompatible',
                      'Orca versions are not compatible'
                    )
                  : failure.kind === 'connection-interrupted'
                    ? translate(
                        'auto.components.settings.RuntimeHostAccessForm.interrupted',
                        'Connection interrupted'
                      )
                    : failure.kind === 'environment-save-failed'
                      ? translate(
                          'auto.components.settings.RuntimeHostAccessForm.saveFailed',
                          'Could not save the host'
                        )
                      : translate(
                          'auto.components.settings.RuntimeHostAccessForm.unavailable',
                          'Host unavailable'
                        )}
          </div>
          <p className="text-xs text-muted-foreground">
            {failure.kind === 'environment-save-failed'
              ? failure.message
              : translateRemotePairingFailureDescription(
                  failure.kind,
                  parsed.ok ? parsed.value.displayEndpoint : null
                )}
          </p>
        </div>
      ) : null}

      <details className="group text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground">
          {translate('auto.components.settings.RuntimeHostAccessForm.advanced', 'Advanced')}
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        {parsed.ok && parsed.value.endpointKind === 'loopback' ? (
          <label className="mt-3 flex items-start gap-2 rounded-md border border-border/60 p-3">
            <Checkbox
              checked={allowLoopback}
              disabled={busy}
              onCheckedChange={(checked) => setAllowLoopback(checked === true)}
            />
            <span className="space-y-1">
              <span className="block font-medium text-foreground">
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.sshTunnel',
                  'I am using an SSH tunnel to this local address'
                )}
              </span>
              <span className="block text-muted-foreground">
                {translate(
                  'auto.components.settings.RuntimeHostAccessForm.sshTunnelHelp',
                  'Keep the tunnel active while using this connection.'
                )}
              </span>
            </span>
          </label>
        ) : (
          <p className="mt-2 text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeHostAccessForm.headlessHelp',
              'Using headless orca serve? Run orca serve --pairing-address <reachable-host> on the other computer.'
            )}
          </p>
        )}
      </details>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.settings.RuntimeHostAccessForm.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {tunnelOverrideEnabled
            ? translate(
                'auto.components.settings.RuntimeHostAccessForm.addWithTunnel',
                'Add host using tunnel'
              )
            : translate('auto.components.settings.RuntimeHostAccessForm.addHost', 'Add host')}
        </Button>
      </div>
    </form>
  )
}
