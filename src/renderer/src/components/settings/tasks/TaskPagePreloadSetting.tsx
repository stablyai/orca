import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getTaskPagePreloadSearchEntry } from './tasks-search'

export function TaskPagePreloadSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getTaskPagePreloadSearchEntry()
  return (
    <SettingsGroup title={t('auto.components.settings.TasksPane.pageTitle', 'Tasks page')}>
      <SearchableSetting
        title={entry.title}
        description={entry.description}
        keywords={entry.keywords}
      >
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={settings.preloadTaskPage === true}
          onChange={() => updateSettings({ preloadTaskPage: settings.preloadTaskPage !== true })}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
