import { translateSearchKeyword } from '../search/settings-search-keywords'
import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function getAutoSaveSearchEntry() {
  return {
    title: translate('settings.general.autoSave.title', 'Auto save'),
    description: translate(
      'settings.general.autoSave.description',
      'Save edits after a short pause.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.auto_save', 'auto save'),
      ...translateSearchKeyword('auto.components.settings.general.search.86f54575c7', 'autosave'),
      ...translateSearchKeyword('auto.components.settings.general.search.4469b6fa4e', 'save'),
      translate(
        'auto.components.settings.GeneralEditorSettingsSection.a37865966c',
        'Auto save files'
      )
    ]
  }
}

export function GeneralAutoSaveSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getAutoSaveSearchEntry()
  return (
    <SearchableSetting id={GENERAL_SETTING_ANCHORS.autoSave} {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorAutoSave}
        onChange={() => updateSettings({ editorAutoSave: !settings.editorAutoSave })}
      />
    </SearchableSetting>
  )
}
