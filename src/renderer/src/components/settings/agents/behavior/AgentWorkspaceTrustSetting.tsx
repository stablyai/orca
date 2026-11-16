import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useTranslate } from '../../../../i18n/use-translate'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import {
  getAgentWorkspaceTrustTitle,
  getAgentWorkspaceTrustDescription
} from './agent-workspace-trust-copy'

export function AgentWorkspaceTrustSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}) {
  const t = useTranslate()
  const enabled = settings.agentWorkspaceTrustEnabled !== false
  return (
    <SettingsSwitchRow
      label={getAgentWorkspaceTrustTitle(t)}
      description={getAgentWorkspaceTrustDescription(t)}
      checked={enabled}
      onChange={() => updateSettings({ agentWorkspaceTrustEnabled: !enabled })}
      ariaLabel={getAgentWorkspaceTrustTitle(t)}
    />
  )
}
