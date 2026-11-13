import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  getCoordinatorApprovalsDescription,
  getCoordinatorApprovalsTitle
} from './coordinator-approvals-copy'
import { useTranslate } from '../../../i18n/use-translate'

type OrchestrationCoordinatorApprovalsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationCoordinatorApprovalsSetting({
  settings,
  updateSettings
}: OrchestrationCoordinatorApprovalsSettingProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.orchestrationCoordinatorApprovalsEnabled === true
  return (
    <SettingsSwitchRow
      label={getCoordinatorApprovalsTitle(t)}
      description={getCoordinatorApprovalsDescription(t)}
      checked={enabled}
      ariaLabel={getCoordinatorApprovalsTitle(t)}
      onChange={() => {
        void updateSettings({ orchestrationCoordinatorApprovalsEnabled: !enabled })
      }}
    />
  )
}
