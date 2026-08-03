import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseServerShareAddress } from '../../../../shared/network/server-share-address'
import { GeneratedUrlRow, UnavailableUrlRow } from './RuntimePairingGeneratedUrlRows'
import type { RuntimePairingIntent } from './runtime-pairing-link-state'
import { translate } from '@/i18n/i18n'

export type { RuntimePairingIntent } from './runtime-pairing-link-state'

type RuntimePairingGeneratorFormProps = {
  intent: RuntimePairingIntent
  loopbackAddress: string
  networkInterfaces: { name: string; address: string }[]
  selectedAddress: string
  refreshingNetworkInterfaces: boolean
  isGeneratingPairing: boolean
  webClientUrl: string | null
  runtimePairingUrl: string | null
  copiedTarget: 'web' | 'pairing' | null
  generatedAddress: string | null
  onIntentChange: (intent: RuntimePairingIntent) => void
  onSelectedAddressChange: (address: string) => void
  onRefreshNetworkInterfaces: () => void
  onGenerate: () => void
  onCopy: (target: 'web' | 'pairing', value: string) => void
}

export function RuntimePairingGeneratorForm({
  intent,
  loopbackAddress,
  networkInterfaces,
  selectedAddress,
  refreshingNetworkInterfaces,
  isGeneratingPairing,
  webClientUrl,
  runtimePairingUrl,
  copiedTarget,
  generatedAddress,
  onIntentChange,
  onSelectedAddressChange,
  onRefreshNetworkInterfaces,
  onGenerate,
  onCopy
}: RuntimePairingGeneratorFormProps): React.JSX.Element {
  const options: AddressOption[] = networkInterfaces.map((networkInterface) => ({
    value: networkInterface.address,
    label: `${networkInterface.name} (${networkInterface.address})`
  }))
  const generatedIsCurrent = generatedAddress === selectedAddress
  const staleGeneratedLink = generatedAddress !== null && !generatedIsCurrent
  const customAddressResult =
    intent === 'custom' ? parseServerShareAddress(selectedAddress) : { ok: true as const }
  const customAddressInvalid = selectedAddress !== '' && !customAddressResult.ok
  const canGenerate = selectedAddress !== '' && (intent !== 'custom' || customAddressResult.ok)

  return (
    <>
      <div className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.intentQuestion',
              'Where will this link be opened?'
            )}
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                [
                  'another',
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.anotherDevice',
                    'Another device'
                  ),
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.anotherDeviceHelp',
                    'Tailscale, LAN, or another reachable address'
                  )
                ],
                [
                  'local',
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.localOnly',
                    'This computer only'
                  ),
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.localOnlyHelp',
                    'A browser or Orca client on this computer'
                  )
                ],
                [
                  'custom',
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.customAddress',
                    'Custom address'
                  ),
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.customAddressHelp',
                    'SSH tunnel, reverse proxy, or custom hostname'
                  )
                ]
              ] as const
            ).map(([value, label, description]) => (
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

        {intent === 'local' ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="font-medium">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.localLink',
                'Local-only link'
              )}
            </div>
            <p className="mt-1 text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.localLinkHelp',
                'This link only works in a browser or Orca client running on this computer.'
              )}
            </p>
            <div className="mt-2 font-mono">{loopbackAddress}</div>
          </div>
        ) : intent === 'custom' ? (
          <div className="space-y-1">
            <Label htmlFor="runtime-pairing-custom-address">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.custom-title',
                'Custom connection address'
              )}
            </Label>
            <Input
              id="runtime-pairing-custom-address"
              value={selectedAddress}
              onChange={(event) => onSelectedAddressChange(event.target.value)}
              placeholder={translate(
                'auto.components.settings.RuntimePairingUrlGenerator.45cf476df3',
                'host, host:port, or wss://host/path'
              )}
              className="font-mono"
              aria-invalid={customAddressInvalid}
              aria-describedby="runtime-pairing-custom-address-help"
              autoFocus
            />
            <p
              id="runtime-pairing-custom-address-help"
              className={
                customAddressInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
              }
            >
              {customAddressInvalid
                ? translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.customInvalid',
                    'Enter a valid host, host:port, IPv6 address, or ws(s):// URL.'
                  )
                : translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-hint',
                    'Enter a host, host:port, or a ws(s):// URL.'
                  )}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <Label id="runtime-pairing-address-label" htmlFor="runtime-pairing-address">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.de77eb1b65',
                'Connection address'
              )}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <AddressPicker
                id="runtime-pairing-address"
                // Why: bounded width so a short value like "This computer
                // (127.0.0.1)" doesn't stretch the trigger across the whole card;
                // the value can grow up to the card edge before truncating.
                className="min-w-[240px] max-w-full"
                triggerAriaLabel={translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.de77eb1b65',
                  'Connection address'
                )}
                options={options}
                value={selectedAddress}
                onValueChange={onSelectedAddressChange}
                placeholder=""
                customInputId="runtime-pairing-custom-address"
                formatCustomLabel={(address) =>
                  translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-option',
                    '{{address}} (custom)',
                    { address }
                  )
                }
                addCustomLabel={translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.add-custom',
                  'Use custom address…'
                )}
                validateCustom={parseServerShareAddress}
                customDialogCopy={{
                  title: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-title',
                    'Custom connection address'
                  ),
                  description: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-description',
                    'Advertise an address another device can reach — a LAN or Tailscale host, or a full ws(s):// URL.'
                  ),
                  inputLabel: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.4531ea3158',
                    'Custom address'
                  ),
                  placeholder: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.45cf476df3',
                    'host, host:port, or wss://host/path'
                  ),
                  hint: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-hint',
                    'Enter a host, host:port, or a ws(s):// URL.'
                  ),
                  cancel: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-cancel',
                    'Cancel'
                  ),
                  confirm: translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.custom-use',
                    'Use address'
                  )
                }}
              />
              {/* Why: server sharing uses the same interface list as Mobile,
                and VPN/tailnet addresses can appear after Settings opens. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={onRefreshNetworkInterfaces}
                    disabled={refreshingNetworkInterfaces}
                    aria-label={translate(
                      'auto.components.settings.RuntimePairingUrlGenerator.360c548cf3',
                      'Refresh connection addresses'
                    )}
                    className="text-muted-foreground"
                  >
                    <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.settings.RuntimePairingUrlGenerator.360c548cf3',
                    'Refresh connection addresses'
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
            {intent === 'another' &&
            networkInterfaces.length === 0 &&
            !refreshingNetworkInterfaces ? (
              <p role="alert" className="text-xs text-destructive">
                {translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.noExternalAddress',
                  'No address for another device was found. Connect this computer to a LAN or Tailscale, refresh, or choose Custom address.'
                )}
              </p>
            ) : null}
          </div>
        )}
        {staleGeneratedLink && selectedAddress !== '' ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.staleAddress',
              'The connection address changed. Generate a new link for {{address}}.',
              { address: selectedAddress }
            )}
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={onGenerate}
            disabled={isGeneratingPairing || !canGenerate}
          >
            {isGeneratingPairing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.8de0f84fff',
              'Generate Access Link'
            )}
          </Button>
        </div>
      </div>

      {generatedIsCurrent && webClientUrl ? (
        <GeneratedUrlRow
          label={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.6b9ca3e69b',
            'Open in browser'
          )}
          description={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.1ca2e5194d',
            'Use this URL from a browser that can reach the selected address.'
          )}
          value={webClientUrl}
          copied={copiedTarget === 'web'}
          onCopy={() => onCopy('web', webClientUrl)}
        />
      ) : generatedIsCurrent && runtimePairingUrl ? (
        <UnavailableUrlRow
          label={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.6b9ca3e69b',
            'Open in browser'
          )}
          description={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.f7cafdc9f3',
            'Browser link unavailable in this build. The pairing URL still works for Orca clients.'
          )}
        />
      ) : null}

      {generatedIsCurrent && runtimePairingUrl ? (
        <GeneratedUrlRow
          label={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.2e5c4e3c93',
            'Pair another Orca client'
          )}
          description={translate(
            'auto.components.settings.RuntimePairingUrlGenerator.849825e829',
            'Paste this pairing URL into another Orca client.'
          )}
          value={runtimePairingUrl}
          copied={copiedTarget === 'pairing'}
          onCopy={() => onCopy('pairing', runtimePairingUrl)}
        />
      ) : null}
    </>
  )
}
