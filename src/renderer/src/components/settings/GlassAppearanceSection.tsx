import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { clampNumber } from '@/lib/terminal-theme'
import { useMountedRef } from '@/hooks/useMountedRef'

type GlassAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * Glass Mode + Glass Opacity. These used to live under Terminal → Window as
 * "Window Blur" and "Background Opacity", but the effect is now app-wide
 * (translucent window with the desktop blurred through the whole shell), so they
 * belong in Appearance.
 */
export function GlassAppearanceSection({
  settings,
  updateSettings
}: GlassAppearanceSectionProps): React.JSX.Element {
  // Why: windowBackgroundBlur is only read by createMainWindow() at startup
  // (macOS vibrancy / Windows acrylic both require window-creation options), so
  // the UI has to ask the user to restart for the change to take effect.
  // Snapshot the value on first render and compare to the live setting to show a
  // "Restart required" banner only when they differ.
  const blurAtMountRef = useRef<boolean>(settings.windowBackgroundBlur ?? false)
  const blurPendingRestart = (settings.windowBackgroundBlur ?? false) !== blurAtMountRef.current
  const [relaunching, setRelaunching] = useState(false)
  const mountedRef = useMountedRef()

  // Why: the mount-time snapshot captures local state; if settings load async,
  // keep the ref honest so the banner only appears on a real user-driven change.
  useEffect(() => {
    blurAtMountRef.current = settings.windowBackgroundBlur ?? false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRelaunch = async (): Promise<void> => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    try {
      await window.api.app.relaunch()
    } catch {
      if (mountedRef.current) {
        setRelaunching(false)
      }
    }
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title="Window Glass" />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title="Glass Mode"
          description="Make the window translucent so the blurred desktop shows through the whole app."
          keywords={[
            'glass',
            'blur',
            'vibrancy',
            'acrylic',
            'transparent',
            'translucent',
            'window',
            'background'
          ]}
          className="space-y-3 py-2"
        >
          <SettingsSwitchRow
            label="Glass Mode"
            description="Turn the whole app — sidebars, terminals, editor, and panels — into translucent glass with the desktop blurred behind it. Requires a restart."
            checked={settings.windowBackgroundBlur ?? false}
            onChange={() =>
              updateSettings({ windowBackgroundBlur: !settings.windowBackgroundBlur })
            }
          />

          {blurPendingRestart ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                  Restart required
                </p>
                <p className="text-xs text-muted-foreground">
                  Restart Orca to apply the Glass Mode change.
                </p>
              </div>
              <Button
                size="sm"
                variant="default"
                className="shrink-0 gap-1.5"
                disabled={relaunching}
                onClick={() => void handleRelaunch()}
              >
                <RotateCw className={`size-3 ${relaunching ? 'animate-spin' : ''}`} />
                {relaunching ? 'Restarting…' : 'Restart now'}
              </Button>
            </div>
          ) : null}
        </SearchableSetting>

        <SearchableSetting
          title="Glass Opacity"
          description="How opaque the app surfaces are in Glass Mode."
          keywords={['glass', 'opacity', 'transparency', 'background', 'alpha', 'blur']}
        >
          <NumberField
            label="Glass Opacity"
            description="How opaque the app surfaces are when Glass Mode is on. 1 is fully solid, 0 is transparent. Has no effect while Glass Mode is off."
            value={settings.terminalBackgroundOpacity ?? 1}
            defaultValue={1}
            min={0}
            max={1}
            step={0.05}
            suffix="0 to 1"
            onChange={(value) =>
              updateSettings({ terminalBackgroundOpacity: clampNumber(value, 0, 1) })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
