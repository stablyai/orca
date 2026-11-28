import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  getOrchestrationNoticesDescription,
  getOrchestrationNoticesTitle
} from './orchestration-notices-copy'
import { useTranslate } from '../../../i18n/use-translate'

type OrchestrationNoticesSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationNoticesSetting({
  settings,
  updateSettings
}: OrchestrationNoticesSettingProps): React.JSX.Element {
  const t = useTranslate()
  const shown = settings.showOrchestrationNotices !== false
  return (
    <SettingsSwitchRow
      label={getOrchestrationNoticesTitle(t)}
      description={getOrchestrationNoticesDescription(t)}
      checked={shown}
      ariaLabel={getOrchestrationNoticesTitle(t)}
      onChange={() => {
        void updateSettings({ showOrchestrationNotices: !shown })
      }}
    />
  )
}
