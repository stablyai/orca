import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { getMenuBarIconEntries } from './appearance-system-presence-search'

export function MenuBarIconSetting({
  enabled,
  updateSettings
}: {
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getMenuBarIconEntries({ showMenuBarIcon: true })[0]
  return (
    <SearchableSetting
      title={translate('settings.appearance.menuBarIcon.title', 'Show Menu Bar Icon')}
      description={entry?.description}
      keywords={entry?.keywords ?? ['menu bar', 'status item', 'activity']}
    >
      <SettingsSwitchRow
        label={translate('settings.appearance.menuBarIcon.title', 'Show Menu Bar Icon')}
        // Hiding the status item preserves Dock activation and close-keeps-running behavior.
        description={translate(
          'settings.appearance.menuBarIcon.description',
          'Keep an Orca shortcut and activity indicator in the macOS menu bar.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ showMenuBarIcon: !enabled })}
      />
    </SearchableSetting>
  )
}
