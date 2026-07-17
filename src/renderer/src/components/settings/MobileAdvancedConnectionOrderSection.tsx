import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { MobileRelayBetaAvailability } from './MobileRelayBetaAvailability'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

type MobileAdvancedConnectionOrderSectionProps = {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  connectionMode: MobilePairingConnectionMode
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddresses: readonly string[]
  onSelectedAddressesChange: (addresses: string[]) => void
  relayPreferenceIndex: number
  onRouteOrderChange: (addresses: string[], relayIndex: number) => void
  refreshingNetworkInterfaces: boolean
  onRefreshNetworkInterfaces: () => void
  className?: string
}

export function MobileAdvancedConnectionOrderSection({
  enabled,
  onEnabledChange,
  connectionMode,
  networkInterfaces,
  selectedAddresses,
  onSelectedAddressesChange,
  relayPreferenceIndex,
  onRouteOrderChange,
  refreshingNetworkInterfaces,
  onRefreshNetworkInterfaces,
  className
}: MobileAdvancedConnectionOrderSectionProps): React.JSX.Element {
  // Why: match NewWorkspaceComposerCard — a quiet "Advanced" disclosure, not a
  // second full settings header for the same feature.
  const [open, setOpen] = useState(enabled)
  const enableLabel = translate(
    'auto.components.settings.MobileAdvancedConnectionOrderSection.enable',
    'Use custom connection order'
  )

  useEffect(() => {
    if (enabled) {
      setOpen(true)
    }
  }, [enabled])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn(className)}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.MobileAdvancedConnectionOrderSection.advanced',
            'Advanced'
          )}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="collapsible-height-content">
        <div className="space-y-3 pt-2">
          <SettingsRow
            label={enableLabel}
            description={
              <span className="block space-y-0.5">
                <span className="block">
                  {enabled
                    ? translate(
                        'auto.components.settings.MobileAdvancedConnectionOrderSection.enabledDescription',
                        'Enabled — the phone follows the route priority below.'
                      )
                    : translate(
                        'auto.components.settings.MobileAdvancedConnectionOrderSection.enableDescription',
                        'Try selected routes from top to bottom instead of using the standard connection behavior.'
                      )}
                </span>
                <MobileRelayBetaAvailability includeIosAppStore={false} />
              </span>
            }
            control={
              <SettingsSwitch
                checked={enabled}
                onChange={() => onEnabledChange(!enabled)}
                ariaLabel={enableLabel}
              />
            }
            alignTop
          />
          {enabled ? (
            <NetworkInterfacePicker
              networkInterfaces={networkInterfaces}
              selectedAddresses={selectedAddresses}
              onSelectedAddressesChange={onSelectedAddressesChange}
              relayPreferenceIndex={
                connectionMode === 'automatic' ? relayPreferenceIndex : undefined
              }
              onRouteOrderChange={onRouteOrderChange}
              refreshingNetworkInterfaces={refreshingNetworkInterfaces}
              onRefreshNetworkInterfaces={onRefreshNetworkInterfaces}
              className="min-w-[220px] justify-between font-normal"
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
