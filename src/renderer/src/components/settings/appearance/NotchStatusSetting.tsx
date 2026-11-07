import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { getNotchStatusEntries } from './appearance-system-presence-search'

export function NotchStatusSetting({
  enabled,
  updateSettings
}: {
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getNotchStatusEntries({ showNotchStatus: true })[0]
  const title = translate('settings.appearance.notchStatus.title', 'Show Agent Status at the Notch')
  return (
    <SearchableSetting
      title={title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['notch', 'agents', 'status', 'counts']}
    >
      <SettingsSwitchRow
        label={title}
        // Why: the only way to dismiss a permanently visible always-on-top surface.
        description={entry?.description}
        checked={enabled}
        onChange={() => updateSettings({ showNotchStatus: !enabled })}
      />
    </SearchableSetting>
  )
}
