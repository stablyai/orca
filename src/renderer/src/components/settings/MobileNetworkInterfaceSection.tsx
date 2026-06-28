import { ChevronDown, ExternalLink, Loader2, QrCode, RefreshCw, Wifi } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { translate } from '@/i18n/i18n'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

type MobileNetworkInterfaceSectionProps = {
  networkInterfaces: MobileNetworkInterface[]
  connectionAddress: string
  onConnectionAddressChange: (address: string) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  loading: boolean
  hasQrCode: boolean
  onGenerateQr: () => void
}

export function MobileNetworkInterfaceSection({
  networkInterfaces,
  connectionAddress,
  onConnectionAddressChange,
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
            'Connection Address'
          )}
        </span>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {translate(
          'auto.components.settings.MobileNetworkInterfaceSection.d536b5e20d',
          'Enter the address your phone can reach. Pick a discovered interface or type an overlay network address for cross-network access.'
        )}
      </p>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1 sm:max-w-[320px]">
            <div className="flex min-w-0">
              <Input
                value={connectionAddress}
                onChange={(event) => onConnectionAddressChange(event.target.value)}
                placeholder={translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
                  'Enter an address'
                )}
                aria-label={translate(
                  'auto.components.settings.MobileNetworkInterfaceSection.829f63c4bd',
                  'Connection address'
                )}
                className="rounded-r-none font-mono"
              />
              {networkInterfaces.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="rounded-l-none border-l-0"
                      aria-label={translate(
                        'auto.components.settings.MobileNetworkInterfaceSection.0a789fb3f8',
                        'Choose discovered address'
                      )}
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[260px]">
                    {networkInterfaces.map((iface) => (
                      <DropdownMenuItem
                        key={`${iface.name}-${iface.address}`}
                        onSelect={() => onConnectionAddressChange(iface.address)}
                        className="justify-between gap-4 font-mono"
                      >
                        <span>{iface.address}</span>
                        <span className="font-sans text-muted-foreground">{iface.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
          {/* Why: VPN/tailnet interfaces can appear after this pane mounts.
              Re-enumerating OS state here avoids requiring an Orca restart. */}
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
                  'Refresh connection addresses'
                )}
                className="text-muted-foreground"
              >
                <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.settings.MobileNetworkInterfaceSection.a9db5d771d',
                'Refresh connection addresses'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <Button
          onClick={onGenerateQr}
          disabled={loading || !connectionAddress.trim()}
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
                  'In Connection Address, choose or enter the Tailscale address, usually a 100.x.y.z IP.'
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
