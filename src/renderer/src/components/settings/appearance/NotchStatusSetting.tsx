import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { getNotchStatusEntries } from './appearance-system-presence-search'

/** Renders nothing off local macOS: the notch is a desktop-only surface. */
export function NotchStatusSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'showNotchStatus'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const entry = getNotchStatusEntries()[0]
  if (!entry) {
    return null
  }
  const enabled = settings.showNotchStatus === true
  const title = t('settings.appearance.notchStatus.title', 'Show Agent Status at the Notch')
  return (
    <SearchableSetting title={title} description={entry.description} keywords={entry.keywords}>
      <SettingsSwitchRow
        label={title}
        // Why: the only way to dismiss a permanently visible always-on-top surface.
        description={entry.description}
        checked={enabled}
        onChange={() => updateSettings({ showNotchStatus: !enabled })}
      />
    </SearchableSetting>
  )
}
