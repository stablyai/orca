import { useState, type ReactNode } from 'react'
import { ChevronDown, Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type MobilePairingSetupSectionProps = {
  connectionMode: MobilePairingConnectionMode
  /** False when Anywhere is selected but Relay cannot be committed yet. */
  canGenerate?: boolean
  /** Reveals the Relay address disclosure when a settings search matches it. */
  addressDisclosureForcedOpen?: boolean
  connectionPathControl: ReactNode
  networkInterfaces: MobileNetworkInterface[]
  customAddresses: readonly string[]
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  onSelectedAddressChange: (address: string) => void
  onCustomAddressSelect: (address: string) => void
  onCustomAddressRemove: (address: string) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  loading: boolean
  hasQrCode: boolean
  showGenerateAction?: boolean
  onGenerateQr: () => void
}

export function MobilePairingSetupSection({
  connectionMode,
  canGenerate = true,
  addressDisclosureForcedOpen = false,
  connectionPathControl,
  networkInterfaces,
  customAddresses,
  selectedAddress,
  selectedAddressIsCustom,
  onSelectedAddressChange,
  onCustomAddressSelect,
  onCustomAddressRemove,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  loading,
  hasQrCode,
  showGenerateAction = true,
  onGenerateQr
}: MobilePairingSetupSectionProps): React.JSX.Element {
  const usingRelay = connectionMode === 'automatic'
  const [addressDisclosureOpen, setAddressDisclosureOpen] = useState(false)
  // A search hit or a custom address pins the picker open: render it outright
  // rather than behind a trigger that could not collapse it anyway.
  const addressDisclosurePinned = addressDisclosureForcedOpen || selectedAddressIsCustom
  // Relay offers still carry a LAN endpoint for the direct fast path, but main
  // substitutes its own default when the renderer has not resolved one yet.
  // LAN has no such fallback, so it needs an explicit reachable host.
  const generateDisabled = loading || !canGenerate || (!usingRelay && !selectedAddress)
  // "Also use…" frames this as additive under Relay, not a second connection mode.
  // The phone races both paths and direct wins ties when nearby.
  const relayAddressLabel = translate(
    'auto.components.settings.MobilePairingSetupSection.step2RelayDisclosure',
    'Also use a faster local path'
  )

  const addressControls = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <NetworkInterfacePicker
          networkInterfaces={networkInterfaces}
          customAddresses={customAddresses}
          selectedAddress={selectedAddress}
          selectedAddressIsCustom={selectedAddressIsCustom}
          onSelectedAddressChange={onSelectedAddressChange}
          onCustomAddressSelect={onCustomAddressSelect}
          onCustomAddressRemove={onCustomAddressRemove}
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
              'Optional. Pick the Wi‑Fi or Tailscale address your phone should use when nearby — usually faster than Relay. Relay still works when you’re away.'
            )
          : translate(
              'auto.components.settings.MobilePairingSetupSection.step2LocalDescription',
              'The phone must be able to reach this address on Tailscale or Wi‑Fi.'
            )}
      </p>
    </div>
  )

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

      {usingRelay && addressDisclosurePinned ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">{relayAddressLabel}</p>
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            {addressControls}
          </div>
        </div>
      ) : usingRelay ? (
        // Why: Relay makes the address optional, not irrelevant — demote it to a
        // disclosure so the direct fast path stays reachable without clutter.
        <Collapsible open={addressDisclosureOpen} onOpenChange={setAddressDisclosureOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {relayAddressLabel}
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform',
                  addressDisclosureOpen && 'rotate-180'
                )}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
              {addressControls}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.settings.MobilePairingSetupSection.step2Title',
              'This computer’s address'
            )}
          </p>
          {addressControls}
        </div>
      )}

      {showGenerateAction ? (
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
      ) : null}
    </section>
  )
}
