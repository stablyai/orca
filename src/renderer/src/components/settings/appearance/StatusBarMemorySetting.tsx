import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getStatusBarMemoryEntry } from './appearance-status-bar-memory-search'
import { isStatusBarMemoryShown } from '../../../../../shared/diagnostics/status-bar-memory-settings'

export function StatusBarMemorySetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getStatusBarMemoryEntry()
  const checked = isStatusBarMemoryShown(settings)
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={checked}
        onChange={() => updateSettings({ showStatusBarMemory: !checked })}
        ariaLabel={entry.title}
      />
    </SearchableSetting>
  )
}
