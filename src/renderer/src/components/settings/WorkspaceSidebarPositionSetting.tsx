import type React from 'react'
import type { GlobalSettings, WorkspaceSidebarPosition } from '../../../../shared/types'
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
          value={settings.workspaceSidebarPosition ?? 'left'}
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
