import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type SidebarTabsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function SidebarTabsSetting({
  settings,
  updateSettings
}: SidebarTabsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.AppearancePane.showTabsInSidebar.title',
    'Show tabs in sidebar'
  )
  const description = translate(
    'auto.components.settings.AppearancePane.showTabsInSidebar.description',
    'List the active workspace’s tabs under it in the sidebar, with split panes side by side, and hide the top tab bar.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['tabs', 'vertical tabs', 'sidebar', 'arc', 'split', 'tab bar']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.showTabsInSidebar === true}
        onChange={() =>
          updateSettings({ showTabsInSidebar: !(settings.showTabsInSidebar === true) })
        }
      />
    </SearchableSetting>
  )
}
