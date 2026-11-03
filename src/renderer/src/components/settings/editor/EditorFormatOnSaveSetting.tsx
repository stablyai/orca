import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function getFormatOnSaveSearchEntry() {
  return {
    title: translate('settings.editorFormatOnSave.title', 'Format on Save'),
    description: translate(
      'settings.editorFormatOnSave.description',
      'Format text before manual saves and auto save. Configure a formatter command in Settings > Projects. Off by default.'
    ),
    keywords: [
      translate(
        'settings.editorFormatOnSave.keywords',
        'formatter format on save prettier biome gofmt'
      )
    ]
  }
}

export function EditorFormatOnSaveSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getFormatOnSaveSearchEntry()
  return (
    <SearchableSetting {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorFormatOnSave === true}
        onChange={() => updateSettings({ editorFormatOnSave: !settings.editorFormatOnSave })}
      />
    </SearchableSetting>
  )
}
