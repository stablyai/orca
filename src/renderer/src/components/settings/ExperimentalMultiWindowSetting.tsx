import { useRef, useState } from 'react'
import { Loader2, RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { useMountedRef } from '../../hooks/useMountedRef'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type ExperimentalMultiWindowSettingProps = {
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ExperimentalMultiWindowSetting({
  enabled,
  updateSettings
}: ExperimentalMultiWindowSettingProps): React.JSX.Element {
  // Why: File > New Window is wired during main-process menu construction.
  // Keep this setting restart-gated so live broadcasts cannot alter policy.
  const enabledAtMountRef = useRef(enabled)
  const restartRequired = enabled !== enabledAtMountRef.current
  const [relaunching, setRelaunching] = useState(false)
  const mountedRef = useMountedRef()

  const handleRelaunch = (): void => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    void window.api.app.relaunch().catch((error) => {
      console.error('[settings] failed to relaunch for multi-window support:', error)
      if (mountedRef.current) {
        setRelaunching(false)
      }
    })
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.efc5cd3ad7', 'Multi-window')}
      description={translate(
        'auto.components.settings.ExperimentalPane.9403a2fffb',
        'Enable File > New Window for multiple monitor workflows. Requires restart.'
      )}
      keywords={getExperimentalSearchEntry().multiWindow.keywords}
      className="space-y-3 py-2"
      id="experimental-multi-window"
    >
      <SettingsSwitchRow
        label={translate('auto.components.settings.ExperimentalPane.efc5cd3ad7', 'Multi-window')}
        description={translate(
          'auto.components.settings.ExperimentalPane.73d191586e',
          'Adds File > New Window for multiple monitor workflows. Requires restart.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ experimentalMultiWindow: !enabled })}
        ariaLabel={translate(
          'auto.components.settings.ExperimentalPane.multiWindow.toggleLabel',
          'Toggle multi-window'
        )}
      />

      {restartRequired ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium">
              {translate(
                'auto.components.settings.ExperimentalPane.31d6d8d7b4',
                'Restart required'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ExperimentalPane.45513cd4aa',
                'Orca applies multi-window support at startup.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRelaunch}
            disabled={relaunching}
            className="shrink-0"
          >
            {relaunching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )}
            {translate('auto.components.settings.ExperimentalPane.c709b5448c', 'Restart')}
          </Button>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
