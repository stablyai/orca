import { useRef, useState } from 'react'
import { Info, Loader2, RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitch } from './SettingsFormControls'
import { ADVANCED_PANE_SEARCH_ENTRIES, ADVANCED_SEARCH_ENTRY } from './advanced-search'

export { ADVANCED_PANE_SEARCH_ENTRIES }

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
          title="Compatibility"
          description="Low-level workarounds for support troubleshooting."
        />

        <SearchableSetting
          title={ADVANCED_SEARCH_ENTRY.http1Compatibility.title}
          description={ADVANCED_SEARCH_ENTRY.http1Compatibility.description}
          keywords={ADVANCED_SEARCH_ENTRY.http1Compatibility.keywords}
          className="space-y-2 py-2"
          id="advanced-http1-compatibility"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 shrink">
              <div className="flex items-center gap-1.5">
                <Label id="advanced-http1-compatibility-label">HTTP/1.1 Compatibility</Label>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Explain HTTP/1.1 compatibility"
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
                      Use only when a corporate VPN or proxy breaks update downloads with HTTP/2
                      protocol errors. It affects all Electron networking after restart.
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
                <p className="text-xs font-medium">Restart required</p>
                <p className="text-xs text-muted-foreground">
                  Orca applies this networking mode at startup.
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
                Restart
              </Button>
            </div>
          ) : null}
        </SearchableSetting>
      </section>
    </div>
  )
}
