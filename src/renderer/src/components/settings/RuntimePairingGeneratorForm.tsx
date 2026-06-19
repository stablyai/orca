import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { GeneratedUrlRow, UnavailableUrlRow } from './RuntimePairingGeneratedUrlRows'
import { translate } from '@/i18n/i18n'

type RuntimePairingGeneratorFormProps = {
  loopbackAddress: string
  networkInterfaces: { name: string; address: string }[]
  selectedAddress: string
  customAddress: string
  refreshingNetworkInterfaces: boolean
  isGeneratingPairing: boolean
  webClientUrl: string | null
  runtimePairingUrl: string | null
  copiedTarget: 'web' | 'pairing' | null
  onSelectedAddressChange: (address: string) => void
  onCustomAddressChange: (address: string) => void
  onRefreshNetworkInterfaces: () => void
  onGenerate: () => void
  onCopy: (target: 'web' | 'pairing', value: string) => void
}

export function RuntimePairingGeneratorForm({
  loopbackAddress,
  networkInterfaces,
  selectedAddress,
  customAddress,
  refreshingNetworkInterfaces,
  isGeneratingPairing,
  webClientUrl,
  runtimePairingUrl,
  copiedTarget,
  onSelectedAddressChange,
  onCustomAddressChange,
  onRefreshNetworkInterfaces,
  onGenerate,
  onCopy
}: RuntimePairingGeneratorFormProps): React.JSX.Element {
  return (
    <>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <div className="space-y-1">
            <Label id="runtime-pairing-address-label" htmlFor="runtime-pairing-address">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.de77eb1b65',
                'Connection address'
              )}
            </Label>
            <div className="flex min-w-0 items-center gap-2">
              <Select value={selectedAddress} onValueChange={onSelectedAddressChange}>
                <SelectTrigger
                  id="runtime-pairing-address"
                  size="sm"
                  className="min-w-0 flex-1"
                  aria-labelledby="runtime-pairing-address-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={loopbackAddress}>
                    {translate(
                      'auto.components.settings.RuntimePairingUrlGenerator.de6d5cff95',
                      'This computer ('
                    )}
                    {loopbackAddress})
                  </SelectItem>
                  {networkInterfaces.map((networkInterface, index) => (
                    <SelectItem
                      key={`${networkInterface.name}:${networkInterface.address}:${index}`}
                      value={networkInterface.address}
                    >
                      {networkInterface.name} ({networkInterface.address})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <div className="min-w-0 space-y-1">
            <Label htmlFor="runtime-pairing-custom-address">
              {translate(
                'auto.components.settings.RuntimePairingUrlGenerator.4531ea3158',
                'Custom address'
              )}
            </Label>
            <Input
              id="runtime-pairing-custom-address"
              value={customAddress}
              onChange={(event) => onCustomAddressChange(event.target.value)}
              placeholder={translate(
                'auto.components.settings.RuntimePairingUrlGenerator.45cf476df3',
                'host, host:port, or wss://host/path'
              )}
              className="h-8 font-mono text-xs"
            />
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
