import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getMultiWindowSearchEntry } from './multi-window-search-entry'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'

export function ExperimentalMultiWindowSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element | null {
  if (isWebClientLocation()) {
    return null
  }
  const entry = getMultiWindowSearchEntry()
  return (
    <SearchableSetting {...entry} id="experimental-multi-window" className="space-y-3 py-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.multiWindow.copy',
              'Adds File > New Window. Each window has its own project filters and tabs, with accounts and running sessions on this profile.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={settings.experimentalMultiWindow === true}
          ariaLabel={entry.title}
          onChange={() =>
            updateSettings({ experimentalMultiWindow: !settings.experimentalMultiWindow })
          }
        />
      </div>
    </SearchableSetting>
  )
}
