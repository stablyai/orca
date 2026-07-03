import { useRef, useState } from 'react'
import { Info, Loader2, RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { AdvancedNetworkSettingsSection } from './AdvancedNetworkSettingsSection'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitch } from './SettingsFormControls'
import { getAdvancedPaneSearchEntries, getAdvancedSearchEntry } from './advanced-search'
import { translate } from '@/i18n/i18n'

export { getAdvancedPaneSearchEntries }

type AdvancedPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AdvancedPane({ settings, updateSettings }: AdvancedPaneProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const http1CompatibilityInitialRef = useRef(Boolean(settings.electronHttp1CompatibilityMode))
  const [http1CompatibilityRelaunching, setHttp1CompatibilityRelaunching] = useState(false)
  const http1CompatibilityEnabled = Boolean(settings.electronHttp1CompatibilityMode)
  const http1CompatibilityRestartRequired =
    http1CompatibilityEnabled !== http1CompatibilityInitialRef.current

  const toggleHttp1CompatibilityMode = (): void => {
    updateSettings({ electronHttp1CompatibilityMode: !http1CompatibilityEnabled })
  }

  const handleHttp1CompatibilityRelaunch = (): void => {
    setHttp1CompatibilityRelaunching(true)
    void window.api.app.relaunch().catch((error) => {
      console.error('[settings] failed to relaunch for HTTP/1.1 compatibility:', error)
      if (mountedRef.current) {
        setHttp1CompatibilityRelaunching(false)
      }
    })
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AdvancedPane.8d8d8ac599', 'Compatibility')}
          description={translate(
            'auto.components.settings.AdvancedPane.8b7a8df299',
            'Low-level workarounds for support troubleshooting.'
          )}
        />

        <SearchableSetting
          title={getAdvancedSearchEntry().http1Compatibility.title}
          description={getAdvancedSearchEntry().http1Compatibility.description}
          keywords={getAdvancedSearchEntry().http1Compatibility.keywords}
          className="space-y-2 py-2"
          id="advanced-http1-compatibility"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 shrink">
              <div className="flex items-center gap-1.5">
                <Label id="advanced-http1-compatibility-label">
                  {translate(
                    'auto.components.settings.AdvancedPane.e9506d3377',
                    'HTTP/1.1 Compatibility'
                  )}
                </Label>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={translate(
                          'auto.components.settings.AdvancedPane.6627e75c92',
                          'Explain HTTP/1.1 compatibility'
                        )}
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={6}
                      className="max-w-[280px] leading-relaxed"
                    >
                      {translate(
                        'auto.components.settings.AdvancedPane.b3ad629640',
                        'Use only when a corporate VPN or proxy breaks update downloads with HTTP/2 protocol errors. It affects all Electron networking after restart.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
            <SettingsSwitch
              checked={http1CompatibilityEnabled}
              onChange={toggleHttp1CompatibilityMode}
              ariaLabelledBy="advanced-http1-compatibility-label"
            />
          </div>

          {http1CompatibilityRestartRequired ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {translate(
                    'auto.components.settings.AdvancedPane.89958d7edf',
                    'Restart required'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.AdvancedPane.87a2cb2ac8',
                    'Orca applies this networking mode at startup.'
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleHttp1CompatibilityRelaunch}
                disabled={http1CompatibilityRelaunching}
                className="shrink-0 gap-1.5"
              >
                {http1CompatibilityRelaunching ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
                {translate('auto.components.settings.AdvancedPane.40b29e0bf3', 'Restart')}
              </Button>
            </div>
          ) : null}
        </SearchableSetting>
      </section>

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AdvancedPane.network', 'Network')}
          description={translate(
            'auto.components.settings.AdvancedPane.networkDescription',
            'App-level network routing for proxies and corporate environments.'
          )}
        />
        <AdvancedNetworkSettingsSection settings={settings} updateSettings={updateSettings} />
      </section>
    </div>
  )
}
