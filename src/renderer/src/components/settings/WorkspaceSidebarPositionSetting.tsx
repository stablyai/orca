import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorkspaceSidebarPosition } from '../../../../shared/ui-chrome-types'
import { normalizeWorkspaceSidebarPosition } from '../../../../shared/workspace-sidebar-position'
import { translate } from '@/i18n/i18n'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

type WorkspaceSidebarPositionSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WorkspaceSidebarPositionSetting({
  settings,
  updateSettings
}: WorkspaceSidebarPositionSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.AppearancePane.workspaceSidebarPosition.title',
    'Workspace List Position'
  )
  return (
    <SettingsRow
      alignTop
      label={title}
      description={translate(
        'auto.components.settings.AppearancePane.workspaceSidebarPosition.rowDescription',
        'Pick the edge for the workspace list. Explorer, Agents, and Source Control move to the opposite edge.'
      )}
      control={
        <SettingsSegmentedControl<WorkspaceSidebarPosition>
          size="sm"
          value={normalizeWorkspaceSidebarPosition(settings.workspaceSidebarPosition)}
          onChange={(workspaceSidebarPosition) => updateSettings({ workspaceSidebarPosition })}
          ariaLabel={title}
          options={[
            {
              value: 'left',
              label: translate(
                'auto.components.settings.AppearancePane.workspaceSidebarPosition.left',
                'Left'
              )
            },
            {
              value: 'right',
              label: translate(
                'auto.components.settings.AppearancePane.workspaceSidebarPosition.right',
                'Right'
              )
            }
          ]}
        />
      }
    />
  )
}
