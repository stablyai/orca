import React from 'react'
import { ExternalLink, Loader2, QrCode, RefreshCw, Wifi } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

type MobileNetworkInterfaceSectionProps = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  loading: boolean
  hasQrCode: boolean
  onGenerateQr: () => void
}

export function MobileNetworkInterfaceSection({
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  loading,
  hasQrCode,
  onGenerateQr
}: MobileNetworkInterfaceSectionProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wifi className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {translate(
            'auto.components.settings.MobileNetworkInterfaceSection.406a35121c',
            'Network Interface'
          )}
        </span>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {translate(
          'auto.components.settings.MobileNetworkInterfaceSection.d536b5e20d',
          'Choose which network address to advertise in the QR code. Use your LAN address for same-network pairing, or an overlay network address (Tailscale, ZeroTier) for cross-network access.'
        )}
      </p>
      <div className="space-y-3">
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
                  'auto.components.settings.MobileNetworkInterfaceSection.a9db5d771d',
                  'Refresh network interfaces'
                )}
                className="text-muted-foreground"
              >
                <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.settings.MobileNetworkInterfaceSection.a9db5d771d',
                'Refresh network interfaces'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <Button
          onClick={onGenerateQr}
          disabled={loading || !selectedAddress}
          size="sm"
          className="gap-1.5"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : hasQrCode ? (
            <RefreshCw className="size-3.5" />
          ) : (
            <QrCode className="size-3.5" />
          )}
          {hasQrCode
            ? translate(
                'auto.components.settings.MobileNetworkInterfaceSection.1e64659126',
                'Regenerate'
              )
            : translate(
                'auto.components.settings.MobileNetworkInterfaceSection.c541f67790',
                'Generate QR Code'
              )}
        </Button>
      </div>
      <Accordion type="single" collapsible className="mt-4 border-t border-border/60 pt-2">
        <AccordionItem value="remote-pairing-guide">
          <AccordionTrigger className="py-2 text-xs">
            {translate(
              'auto.components.settings.MobileNetworkInterfaceSection.39fad211d9',
              'Connect outside your Wi-Fi with a tailnet'
            )}
          </AccordionTrigger>
          <AccordionContent className="space-y-3 text-xs text-muted-foreground">
            <p>
              {translate(
                'auto.components.settings.MobileNetworkInterfaceSection.9fc5d203ff',
                'Orca Mobile connects directly to this computer. To use it away from the same local network, put your computer and phone on the same private overlay network, then generate the QR code with that network address selected.'
              )}
            </p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.51d29927eb',
                  'Install'
                )}{' '}
                <button
                  type="button"
                  onClick={() => void window.api.shell.openUrl(TAILSCALE_DOWNLOAD_URL)}
                  className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {translate(
                    'auto.components.settings.MobileNetworkInterfaceSection.1dc87a7fbc',
                    'Tailscale'
                  )}
                  <ExternalLink className="size-3" />
                </button>{' '}
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.668016be7a',
                  'on your computer and phone.'
                )}
              </li>
              <li>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.1f7c26d36a',
                  'Sign in to the same tailnet on both devices.'
                )}
              </li>
              <li>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.87985ba6f5',
                  'In this Network Interface menu, choose the Tailscale address, usually a 100.x.y.z IP.'
                )}
              </li>
              <li>
                {translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.63d5e4ae1e',
                  'Regenerate the QR code and scan it from the Orca mobile app.'
                )}
              </li>
            </ol>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
