import type { JSX } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getShowUsageButtonEntry } from './appearance-sidebar-search'

type AppearanceUsageButtonSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Sidebar-toolbar shortcut for the token usage drawer; hiding it closes an open drawer. */
export function AppearanceUsageButtonSetting({
  settings,
  updateSettings
}: AppearanceUsageButtonSettingProps): JSX.Element {
  const entry = getShowUsageButtonEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsSwitchRow
        label={entry.title}
        checked={settings.showUsageButton !== false}
        onChange={() => updateSettings({ showUsageButton: !(settings.showUsageButton !== false) })}
      />
    </SearchableSetting>
  )
}
