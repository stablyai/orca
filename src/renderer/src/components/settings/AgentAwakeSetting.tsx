import { getRendererAppPlatform } from '../../lib/renderer-app-platform'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import {
  getAgentAwakeDescription,
  getAgentAwakeModeLabel,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle,
  getKeepDisplayAwakeDescription,
  getKeepDisplayAwakeTitle
} from './agent-awake-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  type ComputerAwakeMode
} from '../../../../shared/computer-awake-mode'

type AgentAwakeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentAwakeSetting({
  settings,
  updateSettings
}: AgentAwakeSettingProps): React.JSX.Element {
  const title = getAgentAwakeTitle()
  const description = getAgentAwakeDescription()
  const mode = normalizeComputerAwakeMode(
    settings.computerAwakeMode,
    settings.keepComputerAwakeWhileAgentsRun
  )
  const showDisplayToggle = getRendererAppPlatform() === 'darwin'
  const setMode = (nextMode: ComputerAwakeMode): void => {
    updateSettings(computerAwakeSettingsForMode(nextMode))
  }

  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={description}
        keywords={getAgentAwakeSearchKeywords()}
      >
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>{title}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <SettingsSegmentedControl
            value={mode}
            onChange={setMode}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'on',
                label: getAgentAwakeModeLabel('on')
              },
              {
                value: 'auto',
                label: getAgentAwakeModeLabel('auto')
              },
              {
                value: 'off',
                label: getAgentAwakeModeLabel('off')
              }
            ]}
          />
        </div>
      </SearchableSetting>
      {showDisplayToggle ? (
        <SearchableSetting
          title={getKeepDisplayAwakeTitle()}
          description={getKeepDisplayAwakeDescription()}
        >
          <SettingsSwitchRow
            label={getKeepDisplayAwakeTitle()}
            description={getKeepDisplayAwakeDescription()}
            checked={settings.keepDisplayAwake === true}
            disabled={mode === 'off'}
            onChange={(checked) => updateSettings({ keepDisplayAwake: checked })}
          />
        </SearchableSetting>
      ) : null}
    </section>
  )
}
