import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  getWorkerAutoReleaseDescription,
  getWorkerAutoReleaseTitle
} from './worker-auto-release-copy'
import { useTranslate } from '../../../i18n/use-translate'

type OrchestrationWorkerAutoReleaseSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationWorkerAutoReleaseSetting({
  settings,
  updateSettings
}: OrchestrationWorkerAutoReleaseSettingProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.orchestrationWorkerAutoReleaseEnabled !== false
  return (
    <SettingsSwitchRow
      label={getWorkerAutoReleaseTitle(t)}
      description={getWorkerAutoReleaseDescription(t)}
      checked={enabled}
      ariaLabel={getWorkerAutoReleaseTitle(t)}
      onChange={() => {
        void updateSettings({ orchestrationWorkerAutoReleaseEnabled: !enabled })
      }}
    />
  )
}
