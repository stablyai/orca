import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseServerShareAddress } from '../../../../shared/network/server-share-address'
import { GeneratedUrlRow, UnavailableUrlRow } from './RuntimePairingGeneratedUrlRows'
import { translate } from '@/i18n/i18n'

type RuntimePairingGeneratorFormProps = {
  loopbackAddress: string
  networkInterfaces: { name: string; address: string }[]
  selectedAddress: string
  refreshingNetworkInterfaces: boolean
  isGeneratingPairing: boolean
  webClientUrl: string | null
  runtimePairingUrl: string | null
  copiedTarget: 'web' | 'pairing' | null
  onSelectedAddressChange: (address: string) => void
  onRefreshNetworkInterfaces: () => void
  onGenerate: () => void
  onCopy: (target: 'web' | 'pairing', value: string) => void
}

export function RuntimePairingGeneratorForm({
  loopbackAddress,
  networkInterfaces,
  selectedAddress,
  refreshingNetworkInterfaces,
  isGeneratingPairing,
  webClientUrl,
  runtimePairingUrl,
  copiedTarget,
  onSelectedAddressChange,
  onRefreshNetworkInterfaces,
  onGenerate,
  onCopy
}: RuntimePairingGeneratorFormProps): React.JSX.Element {
  const options: AddressOption[] = [
    {
      value: loopbackAddress,
      label: `${translate(
        'auto.components.settings.RuntimePairingUrlGenerator.de6d5cff95',
        'This computer ('
      )}${loopbackAddress})`
    },
    ...networkInterfaces.map((networkInterface) => ({
      value: networkInterface.address,
      label: `${networkInterface.name} (${networkInterface.address})`
    }))
  ]

  return (
    <>
      <div className="space-y-3">
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
                'Add custom address…'
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
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimePairingUrlGenerator.279e0dcb57',
            '127.0.0.1 only works on this computer. Use a LAN, Tailscale, or custom address for another device.'
          )}
        </p>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onGenerate}
            disabled={isGeneratingPairing}
          >
            {isGeneratingPairing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.8de0f84fff',
              'Generate Access Link'
            )}
          </Button>
        </div>
      </div>

      {webClientUrl ? (
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
      ) : runtimePairingUrl ? (
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

      {runtimePairingUrl ? (
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
