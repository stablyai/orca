import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { Label } from '../../../ui/label'
import {
  getAgentAwakeDescription,
  getAgentAwakeModeLabel,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle
} from './agent-awake-copy'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  type ComputerAwakeMode
} from '../../../../../../shared/computer-awake-mode'
import { useTranslate } from '../../../../i18n/use-translate'

type AgentAwakeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentAwakeSetting({
  settings,
  updateSettings
}: AgentAwakeSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = getAgentAwakeTitle(t)
  const description = getAgentAwakeDescription(undefined, t)
  const mode = normalizeComputerAwakeMode(
    settings.computerAwakeMode,
    settings.keepComputerAwakeWhileAgentsRun
  )
  const setMode = (nextMode: ComputerAwakeMode): void => {
    updateSettings(computerAwakeSettingsForMode(nextMode))
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={getAgentAwakeSearchKeywords(undefined, t)}
    >
      <div className="flex items-start justify-between gap-4 py-3">
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
              label: getAgentAwakeModeLabel('on', t)
            },
            {
              value: 'auto',
              label: getAgentAwakeModeLabel('auto', t)
            },
            {
              value: 'off',
              label: getAgentAwakeModeLabel('off', t)
            }
          ]}
        />
      </div>
    </SearchableSetting>
  )
}
