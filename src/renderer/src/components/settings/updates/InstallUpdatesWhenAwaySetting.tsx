import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getInstallUpdatesWhenAwaySearchEntry } from './install-updates-when-away-copy'

export function InstallUpdatesWhenAwaySetting(): React.JSX.Element {
  const t = useTranslate()
  const checked = useAppStore((s) => s.settings?.installUpdatesWhenAway === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const entry = getInstallUpdatesWhenAwaySearchEntry(t)
  return (
    <SearchableSetting {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={checked}
        onChange={() => void updateSettings({ installUpdatesWhenAway: !checked })}
      />
    </SearchableSetting>
  )
}
