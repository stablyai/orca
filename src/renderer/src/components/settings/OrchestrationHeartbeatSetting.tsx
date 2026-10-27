import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getOrchestrationHeartbeatDescription,
  getOrchestrationHeartbeatTitle
} from './orchestration-heartbeat-copy'

type OrchestrationHeartbeatSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationHeartbeatSetting({
  settings,
  updateSettings
}: OrchestrationHeartbeatSettingProps): React.JSX.Element {
  const enabled = settings.orchestrationHeartbeatsEnabled !== false
  return (
    <SettingsSwitchRow
      label={getOrchestrationHeartbeatTitle()}
      description={getOrchestrationHeartbeatDescription()}
      checked={enabled}
      ariaLabel={getOrchestrationHeartbeatTitle()}
      onChange={() => {
        void updateSettings({ orchestrationHeartbeatsEnabled: !enabled })
      }}
    />
  )
}
