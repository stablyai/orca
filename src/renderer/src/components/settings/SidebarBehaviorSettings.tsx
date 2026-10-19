import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type SidebarBehaviorSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function SidebarBehaviorSettings({
  settings,
  updateSettings
}: SidebarBehaviorSettingsProps): React.JSX.Element {
  return (
    <>
      <SearchableSetting
        title={translate(
          'auto.components.settings.AppearancePane.projectHeaderClickOpensWorkspace.title',
          'Click project name to open its workspace'
        )}
        description={translate(
          'auto.components.settings.AppearancePane.projectHeaderClickOpensWorkspace.description',
          'Opens the primary workspace terminal. Use the chevron to collapse.'
        )}
        keywords={['project', 'click', 'open', 'terminal', 'collapse', 'sidebar']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.AppearancePane.projectHeaderClickOpensWorkspace.title',
            'Click project name to open its workspace'
          )}
          description={translate(
            'auto.components.settings.AppearancePane.projectHeaderClickOpensWorkspace.description',
            'Opens the primary workspace terminal. Use the chevron to collapse.'
          )}
          checked={settings.projectHeaderClickOpensWorkspace === true}
          onChange={() =>
            updateSettings({
              projectHeaderClickOpensWorkspace: !(
                settings.projectHeaderClickOpensWorkspace === true
              )
            })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AppearancePane.keepSidebarGroupsCollapsedOnReveal.title',
          'Keep collapsed groups collapsed'
        )}
        description={translate(
          'auto.components.settings.AppearancePane.keepSidebarGroupsCollapsedOnReveal.description',
          "Opening a workspace or agent activity doesn't expand groups you collapsed."
        )}
        keywords={['collapse', 'expand', 'group', 'project', 'remember', 'sidebar']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.AppearancePane.keepSidebarGroupsCollapsedOnReveal.title',
            'Keep collapsed groups collapsed'
          )}
          description={translate(
            'auto.components.settings.AppearancePane.keepSidebarGroupsCollapsedOnReveal.description',
            "Opening a workspace or agent activity doesn't expand groups you collapsed."
          )}
          checked={settings.keepSidebarGroupsCollapsedOnReveal === true}
          onChange={() =>
            updateSettings({
              keepSidebarGroupsCollapsedOnReveal: !(
                settings.keepSidebarGroupsCollapsedOnReveal === true
              )
            })
          }
        />
      </SearchableSetting>
    </>
  )
}
