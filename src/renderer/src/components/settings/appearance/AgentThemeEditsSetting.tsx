import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getAgentThemeEditsEntries } from './appearance-agent-theme-edits-search'

export function AgentThemeEditsSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'allowAgentThemeEdits'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getAgentThemeEditsEntries()[0]
  const enabled = settings.allowAgentThemeEdits !== false
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords ?? []}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() => updateSettings({ allowAgentThemeEdits: !enabled })}
      />
    </SearchableSetting>
  )
}
