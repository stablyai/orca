import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { GeneratedUrlRow, UnavailableUrlRow } from './RuntimePairingGeneratedUrlRows'
import {
  formatCloudflaredQuickTunnelCommand,
  isCloudflareQuickTunnelAddress,
  parseCloudflareTunnelAddress
} from '../../../../shared/network/cloudflare-tunnel-address'
import { translate } from '@/i18n/i18n'

type CloudflareTunnelFieldsProps = {
  address: string
  localPort: number | null
  commandCopied: boolean
  onAddressChange: (address: string) => void
  onCopyCommand: (command: string) => void
}

export function CloudflareTunnelFields({
  address,
  localPort,
  commandCopied,
  onAddressChange,
  onCopyCommand
}: CloudflareTunnelFieldsProps): React.JSX.Element {
  const command = localPort === null ? null : formatCloudflaredQuickTunnelCommand(localPort)
  const addressInvalid = address !== '' && !parseCloudflareTunnelAddress(address).ok
  const quickTunnel = isCloudflareQuickTunnelAddress(address)
  const commandLabel = translate(
    'auto.components.settings.CloudflareTunnelFields.commandLabel',
    'Tunnel command'
  )

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>
          {translate(
            'auto.components.settings.CloudflareTunnelFields.startTunnel',
            'Start the tunnel on this computer'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CloudflareTunnelFields.startTunnelHelp',
            'Run this where Orca is running and leave it open. It prints a public URL.'
          )}
        </p>
        {command === null ? (
          // Why not a placeholder command: a copyable `--url http://127.0.0.1:<port>` is a broken
          // command, and swapping the port in later reads as a glitch (UX rule 1).
          <UnavailableUrlRow
            label={commandLabel}
            description={translate(
              'auto.components.settings.CloudflareTunnelFields.commandUnavailable',
              'The runtime port is not available yet. Reopen this pane once the Orca server is listening.'
            )}
          />
        ) : (
          <GeneratedUrlRow
            label={commandLabel}
            value={command}
            copied={commandCopied}
            onCopy={() => onCopyCommand(command)}
          />
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="runtime-pairing-cloudflare-address">
          {translate('auto.components.settings.CloudflareTunnelFields.addressLabel', 'Tunnel URL')}
        </Label>
        <Input
          id="runtime-pairing-cloudflare-address"
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.CloudflareTunnelFields.addressPlaceholder',
            'https://example.trycloudflare.com'
          )}
          className="font-mono"
          aria-invalid={addressInvalid}
          aria-describedby="runtime-pairing-cloudflare-address-help"
          autoFocus
        />
        <p
          id="runtime-pairing-cloudflare-address-help"
          className={addressInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {addressInvalid
            ? translate(
                'auto.components.settings.CloudflareTunnelFields.addressInvalid',
                'Enter the public https:// or wss:// URL that cloudflared printed.'
              )
            : translate(
                'auto.components.settings.CloudflareTunnelFields.addressHint',
                'Paste the URL cloudflared printed. Orca connects to it over wss://.'
              )}
        </p>
      </div>

      {quickTunnel ? (
        <div
          role="status"
          className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.settings.CloudflareTunnelFields.quickTunnelWarning',
            'Quick tunnel URLs change every time cloudflared restarts. Generate a new link after each restart.'
          )}
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.CloudflareTunnelFields.exposureNote',
          'The tunnel makes this Orca server reachable from the internet while it runs. Revoke the access grant below when you are done.'
        )}
      </p>
    </div>
  )
}
