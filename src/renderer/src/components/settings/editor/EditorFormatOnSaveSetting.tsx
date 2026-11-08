import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function getFormatOnSaveSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editorFormatOnSave.title', 'Format on Save'),
    description: t(
      'settings.editorFormatOnSave.description',
      'Format text before manual saves and auto save. Configure a formatter command in Settings > Projects. Off by default.'
    ),
    keywords: [
      t('settings.editorFormatOnSave.keywords', 'formatter format on save prettier biome gofmt')
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
  const t = useTranslate()
  const entry = getFormatOnSaveSearchEntry(t)
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
