import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SettingsSearchEntry } from './settings-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function ReduceVisualEffectsSetting({
  entry,
  enabled,
  updateSettings
}: {
  entry: SettingsSearchEntry | undefined
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate('settings.appearance.reduceVisualEffects.title', 'Reduce Visual Effects')
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
