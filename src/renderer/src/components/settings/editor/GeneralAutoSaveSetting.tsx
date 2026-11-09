import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function GeneralAutoSaveSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.general.autoSave.title', 'Auto save')
  const description = t('settings.general.autoSave.description', 'Save edits after a short pause.')
  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.autoSave}
      title={title}
      description={description}
      keywords={[
        'auto save',
        'autosave',
        'save',
        t('auto.components.settings.GeneralEditorSettingsSection.0df2e4fd12', 'Auto Save Files')
      ]}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.editorAutoSave}
        onChange={() => updateSettings({ editorAutoSave: !settings.editorAutoSave })}
      />
    </SearchableSetting>
  )
}
