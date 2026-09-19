import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'
import { translate } from '@/i18n/i18n'

type TiledAgentsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TiledAgentsExperimentalSetting({
  settings,
  updateSettings
}: TiledAgentsExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.experimentalTiledAgents === true

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.TiledAgentsExperimentalSetting.title',
        'Tiled agents'
      )}
      description={translate(
        'auto.components.settings.TiledAgentsExperimentalSetting.description',
        "Collect this worktree's AI agents as cards inside one Agents tab, up to nine at a time."
      )}
      keywords={getExperimentalSearchEntry().tiledAgents.keywords}
      className="space-y-3 py-2"
      id="experimental-tiled-agents"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.TiledAgentsExperimentalSetting.title',
              'Tiled agents'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.TiledAgentsExperimentalSetting.rowDescription',
              'Turns on automatically for any worktree with an agent, no further action needed. Up to nine agents as cards at once.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.TiledAgentsExperimentalSetting.toggleAriaLabel',
            'Toggle tiled agents'
          )}
          onChange={() => updateSettings({ experimentalTiledAgents: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
