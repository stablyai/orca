import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  ORCHESTRATION_HEARTBEAT_INTERVAL_MAX_MINUTES,
  ORCHESTRATION_HEARTBEAT_INTERVAL_MIN_MINUTES,
  resolveOrchestrationHeartbeatInterval
} from '../../../../shared/orchestration-heartbeat'
import { NumberField, SettingsSwitchRow } from './SettingsFormControls'
import {
  getOrchestrationHeartbeatDescription,
  getOrchestrationHeartbeatIntervalDescription,
  getOrchestrationHeartbeatIntervalSuffix,
  getOrchestrationHeartbeatIntervalTitle,
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
    <>
      <SettingsSwitchRow
        label={getOrchestrationHeartbeatTitle()}
        description={getOrchestrationHeartbeatDescription()}
        checked={enabled}
        ariaLabel={getOrchestrationHeartbeatTitle()}
        onChange={() => {
          void updateSettings({ orchestrationHeartbeatsEnabled: !enabled })
        }}
      />
      {enabled ? (
        // Indented under the switch because it only applies while heartbeats are on.
        <div className="ml-4 border-l border-border pl-4">
          <NumberField
            label={getOrchestrationHeartbeatIntervalTitle()}
            description={getOrchestrationHeartbeatIntervalDescription()}
            value={resolveOrchestrationHeartbeatInterval(settings)}
            min={ORCHESTRATION_HEARTBEAT_INTERVAL_MIN_MINUTES}
            max={ORCHESTRATION_HEARTBEAT_INTERVAL_MAX_MINUTES}
            integer
            suffix={getOrchestrationHeartbeatIntervalSuffix()}
            onChange={(orchestrationHeartbeatIntervalMinutes) => {
              void updateSettings({ orchestrationHeartbeatIntervalMinutes })
            }}
          />
        </div>
      ) : null}
    </>
  )
}
