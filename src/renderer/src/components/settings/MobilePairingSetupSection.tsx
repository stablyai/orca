import type { ReactNode } from 'react'
import { ExternalLink, Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

type MobilePairingSetupSectionProps = {
  connectionMode: MobilePairingConnectionMode
  relayConnectionControl: ReactNode
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
  relayConnectionControl,
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  loading,
  hasQrCode,
  onGenerateQr
}: MobilePairingSetupSectionProps): React.JSX.Element {
  return (
    <section>
      <h3 className="text-sm font-medium">
        {translate('auto.components.settings.MobilePairingSetupSection.title', 'Pair a phone')}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {connectionMode === 'automatic'
          ? translate(
              'auto.components.settings.MobilePairingSetupSection.automaticDescription',
              'The pairing code includes direct access and encrypted Orca Relay fallback.'
            )
          : translate(
              'auto.components.settings.MobilePairingSetupSection.localDescription',
              'The pairing code connects only through the local network address below.'
            )}
      </p>
      <div className="mt-2">{relayConnectionControl}</div>
      <Button
        onClick={onGenerateQr}
        disabled={loading || !selectedAddress}
        size="sm"
        className="mt-3 gap-1.5"
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : hasQrCode ? (
          <RefreshCw className="size-3.5" />
        ) : (
          <QrCode className="size-3.5" />
        )}
        {hasQrCode
          ? translate('auto.components.settings.MobilePairingSetupSection.regenerate', 'Regenerate')
          : translate(
              'auto.components.settings.MobilePairingSetupSection.generate',
              'Generate QR Code'
            )}
      </Button>

      <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
        <div className="space-y-1">
          <h4 className="text-xs font-medium">
            {translate(
              'auto.components.settings.MobilePairingSetupSection.localSettings',
              'Local connection settings'
            )}
          </h4>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MobilePairingSetupSection.localAddressDescription',
              'Choose the LAN or private-network address that Orca Mobile can use to reach this computer directly.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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
      </div>

      <Accordion type="single" collapsible className="mt-2">
        <AccordionItem value="tailnet-guide" className="border-b-0">
          <AccordionTrigger className="py-2 text-xs">
            {translate(
              'auto.components.settings.MobilePairingSetupSection.tailnet',
              'Connect with your own tailnet'
            )}
          </AccordionTrigger>
          <AccordionContent className="space-y-3 text-xs text-muted-foreground">
            <p>
              {translate(
                'auto.components.settings.MobilePairingSetupSection.tailnetDescription',
                'Install Tailscale on this computer and your phone, sign in to the same tailnet, then select its 100.x.y.z address above.'
              )}
            </p>
            <button
              type="button"
              onClick={() => void window.api.shell.openUrl(TAILSCALE_DOWNLOAD_URL)}
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              {translate(
                'auto.components.settings.MobilePairingSetupSection.getTailscale',
                'Get Tailscale'
              )}
              <ExternalLink className="size-3" />
            </button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  )
}
