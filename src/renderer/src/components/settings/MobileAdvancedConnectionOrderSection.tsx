import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { OrderedNetworkAddressPicker } from '../mobile/OrderedNetworkAddressPicker'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/YjeGMQBA'
const ANDROID_APK_URL =
  'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.31/app-release.apk'

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
  const handleEnabledChange = (): void => {
    const nextEnabled = !enabled
    if (nextEnabled) {
      setOpen(true)
    }
    onEnabledChange(nextEnabled)
  }

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
                <span className="block">
                  {translate(
                    'auto.components.settings.MobileAdvancedConnectionOrderSection.versionNote',
                    'Requires the latest Orca Mobile:'
                  )}{' '}
                  <button
                    type="button"
                    onClick={() => void window.api.shell.openUrl(TESTFLIGHT_URL)}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {translate(
                      'auto.components.settings.MobileAdvancedConnectionOrderSection.testflight',
                      'TestFlight'
                    )}
                  </button>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => void window.api.shell.openUrl(ANDROID_APK_URL)}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {translate(
                      'auto.components.settings.MobileAdvancedConnectionOrderSection.androidApk',
                      'latest Android APK'
                    )}
                  </button>
                </span>
              </span>
            }
            control={
              <SettingsSwitch
                checked={enabled}
                onChange={handleEnabledChange}
                ariaLabel={enableLabel}
              />
            }
            alignTop
          />
          {enabled ? (
            <OrderedNetworkAddressPicker
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
