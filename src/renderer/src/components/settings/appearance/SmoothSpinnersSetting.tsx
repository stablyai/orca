import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { SettingsSearchEntry } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

export function SmoothSpinnersSetting({
  entry,
  enabled,
  updateSettings
}: {
  entry: SettingsSearchEntry | undefined
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.appearance.smoothSpinners.title', 'Smooth spinners')
  return (
    <SearchableSetting
      title={title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['spinner', 'animation', 'smooth', 'fps']}
    >
      <SettingsSwitchRow
        label={title}
        description={entry?.description}
        checked={enabled}
        onChange={() => updateSettings({ smoothSpinners: !enabled })}
      />
    </SearchableSetting>
  )
}
