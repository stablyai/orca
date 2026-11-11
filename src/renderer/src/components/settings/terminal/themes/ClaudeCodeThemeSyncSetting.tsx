import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { getClaudeCodeThemeSyncSearchEntry } from './terminal-theme-search'

export function ClaudeCodeThemeSyncSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const [entry] = getClaudeCodeThemeSyncSearchEntry()
  return (
    <div className="ml-4">
      <SearchableSetting {...entry} className="border-y border-border/40">
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={settings.claudeCodeThemeSync}
          onChange={() => updateSettings({ claudeCodeThemeSync: !settings.claudeCodeThemeSync })}
        />
      </SearchableSetting>
    </div>
  )
}
