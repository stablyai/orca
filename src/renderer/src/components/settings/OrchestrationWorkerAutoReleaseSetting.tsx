import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getWorkerAutoReleaseDescription,
  getWorkerAutoReleaseTitle
} from './worker-auto-release-copy'

type OrchestrationWorkerAutoReleaseSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationWorkerAutoReleaseSetting({
  settings,
  updateSettings
}: OrchestrationWorkerAutoReleaseSettingProps): React.JSX.Element {
  const enabled = settings.orchestrationWorkerAutoReleaseEnabled !== false
  return (
    <SettingsSwitchRow
      label={getWorkerAutoReleaseTitle()}
      description={getWorkerAutoReleaseDescription()}
      checked={enabled}
      ariaLabel={getWorkerAutoReleaseTitle()}
      onChange={() => {
        void updateSettings({ orchestrationWorkerAutoReleaseEnabled: !enabled })
      }}
    />
  )
}
