import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type DetachedPanesExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function DetachedPanesExperimentalSetting({
  settings,
  updateSettings
}: DetachedPanesExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.experimentalDetachedPanes === true

  return (
    <SearchableSetting
      title={translate(
        'components.settings.experimentalPane.detachedPanes.title',
        'Detached Panes'
      )}
      description={translate(
        'components.settings.experimentalPane.detachedPanes.description',
        'Move a terminal tab group into its own window, for a second monitor.'
      )}
      keywords={['detach', 'window', 'multi-window', 'monitor', 'pane']}
      className="space-y-3 py-2"
      id="experimental-detached-panes"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'components.settings.experimentalPane.detachedPanes.title',
              'Detached Panes'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'components.settings.experimentalPane.detachedPanes.copy',
              'Adds "Move Group to New Window" to the tab menu for terminal-only groups. Detached windows do not yet have a native right-click menu, and paste from the Edit menu does not reach them — use the keyboard inside the terminal.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          onChange={() => updateSettings({ experimentalDetachedPanes: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
