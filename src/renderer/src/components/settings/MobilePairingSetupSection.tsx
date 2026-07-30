import type { ReactNode } from 'react'
import { Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type MobilePairingSetupSectionProps = {
  connectionMode: MobilePairingConnectionMode
  /** False when Anywhere is selected but Relay cannot be committed yet. */
  canGenerate?: boolean
  connectionPathControl: ReactNode
  networkInterfaces: MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  loading: boolean
  hasQrCode: boolean
  onGenerateQr: () => void
}

export function MobilePairingSetupSection({
  connectionMode,
  canGenerate = true,
  connectionPathControl,
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  loading,
  hasQrCode,
  onGenerateQr
}: MobilePairingSetupSectionProps): React.JSX.Element {
  const usingRelay = connectionMode === 'automatic'
  const generateDisabled = loading || !selectedAddress || !canGenerate

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.MobilePairingSetupSection.title', 'Pair a phone')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.MobilePairingSetupSection.overview',
            'Generate a QR code, then scan it in Orca Mobile under Pair Desktop.'
          )}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">
          {translate('auto.components.settings.MobilePairingSetupSection.step1Title', 'Connection')}
        </p>
        {connectionPathControl}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.settings.MobilePairingSetupSection.step2Title',
            'This computer’s address'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <NetworkInterfacePicker
            networkInterfaces={networkInterfaces}
            selectedAddress={selectedAddress}
            onSelectedAddressChange={onSelectedAddressChange}
            className="min-w-[220px] justify-between font-normal"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onRefreshNetworkInterfaces}
                disabled={refreshingNetworkInterfaces}
                aria-label={translate(
                  'auto.components.settings.MobilePairingSetupSection.refresh',
                  'Refresh network interfaces'
                )}
                className="text-muted-foreground"
              >
                <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.settings.MobilePairingSetupSection.refresh',
                'Refresh network interfaces'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="text-xs text-muted-foreground">
          {usingRelay
            ? translate(
                'auto.components.settings.MobilePairingSetupSection.step2RelayDescription',
                'Used for a faster direct path when nearby. Relay covers remote access.'
              )
            : translate(
                'auto.components.settings.MobilePairingSetupSection.step2LocalDescription',
                'The phone must be able to reach this address on Wi‑Fi or Tailscale.'
              )}
        </p>
      </div>

      <div className="space-y-2">
        <Button onClick={onGenerateQr} disabled={generateDisabled} size="sm" className="gap-1.5">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : hasQrCode ? (
            <RefreshCw className="size-3.5" />
          ) : (
            <QrCode className="size-3.5" />
          )}
          {hasQrCode
            ? translate(
                'auto.components.settings.MobilePairingSetupSection.regenerate',
                'Regenerate QR code'
              )
            : translate(
                'auto.components.settings.MobilePairingSetupSection.generate',
                'Generate QR code'
              )}
        </Button>
      </div>
    </section>
  )
}
