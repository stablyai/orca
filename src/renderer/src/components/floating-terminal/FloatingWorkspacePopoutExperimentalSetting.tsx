import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { PopoutExperimentalSetting } from '../dashboard/AgentDashboardExperimentalSetting'
import { getExperimentalSearchEntry } from '../settings/advanced/experimental-search'
import { canOpenFloatingWorkspacePopout } from './floating-workspace-open-mode'

type FloatingWorkspacePopoutExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function FloatingWorkspacePopoutExperimentalSetting({
  settings,
  updateSettings
}: FloatingWorkspacePopoutExperimentalSettingProps): React.JSX.Element | null {
  if (!canOpenFloatingWorkspacePopout()) {
    return null
  }
  const description = translate(
    'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.description',
    'Open the Floating Workspace terminal in its own window.'
  )
  return (
    <PopoutExperimentalSetting
      id="experimental-floating-workspace-popout"
      keywords={getExperimentalSearchEntry().floatingWorkspacePopout.keywords}
      enabled={settings.experimentalFloatingWorkspacePopout === true}
      mode={settings.experimentalFloatingWorkspaceMode ?? 'in-window'}
      canPopout={canOpenFloatingWorkspacePopout()}
      onEnabledChange={(enabled) =>
        updateSettings({ experimentalFloatingWorkspacePopout: enabled })
      }
      onModeChange={(mode) => updateSettings({ experimentalFloatingWorkspaceMode: mode })}
      text={{
        title: translate(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.title',
          'Floating Workspace pop-out'
        ),
        description,
        copy: description,
        toggleLabel: translate(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.toggleLabel',
          'Toggle Floating Workspace pop-out'
        ),
        modeCopy: translate(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.modeCopy',
          'Show the Floating Workspace as an in-window panel or a separate pop-out window.'
        ),
        modeAriaLabel: translate(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.modeAriaLabel',
          'Floating Workspace open mode'
        )
      }}
    />
  )
}
