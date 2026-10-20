import type { RuntimePairingIntent } from './runtime-pairing-link-state'
import { translate } from '@/i18n/i18n'

type RuntimePairingIntentOptionsProps = {
  intent: RuntimePairingIntent
  onIntentChange: (intent: RuntimePairingIntent) => void
}

function intentOptions(): { value: RuntimePairingIntent; label: string; description: string }[] {
  return [
    {
      value: 'another',
      label: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.anotherDevice',
        'Another device'
      ),
      description: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.anotherDeviceHelp',
        'Tailscale, LAN, or another reachable address'
      )
    },
    {
      value: 'cloudflare',
      label: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.cloudflareTunnel',
        'Cloudflare Tunnel'
      ),
      description: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.cloudflareTunnelHelp',
        'Reach this server from outside your network'
      )
    },
    {
      value: 'local',
      label: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.localOnly',
        'This computer only'
      ),
      description: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.localOnlyHelp',
        'A browser or Orca client on this computer'
      )
    },
    {
      value: 'custom',
      label: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.customAddress',
        'Custom address'
      ),
      description: translate(
        'auto.components.settings.RuntimePairingUrlGenerator.customAddressHelp',
        'SSH tunnel, reverse proxy, or custom hostname'
      )
    }
  ]
}

export function RuntimePairingIntentOptions({
  intent,
  onIntentChange
}: RuntimePairingIntentOptionsProps): React.JSX.Element {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {translate(
          'auto.components.settings.RuntimePairingUrlGenerator.intentQuestion',
          'Where will this link be opened?'
        )}
      </legend>
      {/* Why 2 columns, not 4: the settings column is too narrow for four cards — the fourth option
          wrapped "Another device" mid-phrase. A 2x2 grid keeps every label on one line. */}
      <div className="grid gap-2 sm:grid-cols-2">
        {intentOptions().map(({ value, label, description }) => (
          <label
            key={value}
            className="flex cursor-pointer gap-2 rounded-md border border-border p-3 has-[:checked]:border-ring has-[:checked]:ring-1 has-[:checked]:ring-ring"
          >
            <input
              type="radio"
              name="runtime-pairing-intent"
              value={value}
              checked={intent === value}
              onChange={() => onIntentChange(value)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-xs font-medium">
                {label}
                {value === 'another' ? (
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.settings.RuntimePairingUrlGenerator.recommended',
                      'Recommended'
                    )}
                  </span>
                ) : null}
              </span>
              <span className="block text-[11px] text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
