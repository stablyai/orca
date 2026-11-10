import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../../../shared/execution-host'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import {
  getCodexHistorySharingDescription,
  getCodexHistorySharingTitle,
  getCodexHistorySharingUnsupported
} from './codex-history-sharing-copy'
import { useCodexHistorySharingHostSetting } from './use-codex-history-sharing-host-setting'
import { useTranslate } from '@/i18n/use-translate'

export function CodexHistorySharingSetting({
  settings,
  updateSettings,
  hostScope
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  /** The host whose Codex launches write the history links. */
  hostScope: SettingsHostScope
}): React.JSX.Element {
  const t = useTranslate()
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  const hostLabel = hostName ?? getLocalExecutionHostLabel()
  const { setting, update } = useCodexHistorySharingHostSetting(
    hostScope.target,
    hostLabel,
    settings,
    updateSettings
  )
  const enabled = setting.state === 'ready' ? setting.enabled : true
  return (
    <SettingsSwitchRow
      label={getCodexHistorySharingTitle(t)}
      description={
        setting.state === 'unsupported'
          ? getCodexHistorySharingUnsupported(hostLabel, t)
          : getCodexHistorySharingDescription(t)
      }
      checked={enabled}
      disabled={setting.state !== 'ready' || !hostScope.available}
      onChange={() => void update(!enabled)}
    />
  )
}
