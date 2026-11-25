import type React from 'react'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { WorkspaceSidebarPosition } from '../../../../shared/ui-chrome/ui-chrome-types'
import { normalizeWorkspaceSidebarPosition } from '../../../../shared/workspace-sidebar-position'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsRow, SettingsSegmentedControl } from './form-controls/SettingsFormControls'

type WorkspaceSidebarPositionSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WorkspaceSidebarPositionSetting({
  settings,
  updateSettings
}: WorkspaceSidebarPositionSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = t(
    'auto.components.settings.AppearancePane.workspaceSidebarPosition.title',
    'Workspace List Position'
  )
  return (
    <SettingsRow
      alignTop
      label={title}
      description={t(
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
              label: t(
                'auto.components.settings.AppearancePane.workspaceSidebarPosition.left',
                'Left'
              )
            },
            {
              value: 'right',
              label: t(
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
