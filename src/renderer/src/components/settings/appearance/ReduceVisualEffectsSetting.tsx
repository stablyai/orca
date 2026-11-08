import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SettingsSearchEntry } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

export function ReduceVisualEffectsSetting({
  entry,
  enabled,
  updateSettings
}: {
  entry: SettingsSearchEntry | undefined
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.appearance.reduceVisualEffects.title', 'Reduce Visual Effects')
  return (
    <SearchableSetting
      title={title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['blur', 'transparency']}
    >
      <SettingsSwitchRow
        label={title}
        description={entry?.description}
        checked={enabled}
        onChange={() => updateSettings({ reduceVisualEffects: !enabled })}
      />
    </SearchableSetting>
  )
}
