import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
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
  const t = useTranslate()
  if (!canOpenFloatingWorkspacePopout()) {
    return null
  }
  const description = t(
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
        title: t(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.title',
          'Floating Workspace pop-out'
        ),
        description,
        copy: description,
        toggleLabel: t(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.toggleLabel',
          'Toggle Floating Workspace pop-out'
        ),
        modeCopy: t(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.modeCopy',
          'Show the Floating Workspace as an in-window panel or a separate pop-out window.'
        ),
        modeAriaLabel: t(
          'auto.components.settings.ExperimentalPane.floatingWorkspacePopout.modeAriaLabel',
          'Floating Workspace open mode'
        )
      }}
    />
  )
}
