import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getTabProjectColorEntry } from './appearance-sidebar-search'

export function TabProjectColorSetting({
  settings,
  updateSettings,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element {
  const entry = getTabProjectColorEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      forceVisible={forceVisible}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.tintTabsWithProjectColor !== false}
        onChange={() =>
          updateSettings({ tintTabsWithProjectColor: settings.tintTabsWithProjectColor === false })
        }
        ariaLabel={entry.title}
      />
    </SearchableSetting>
  )
}
