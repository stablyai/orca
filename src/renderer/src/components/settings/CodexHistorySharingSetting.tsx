import { useAppStore } from '@/store'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { SettingsHostScope } from './settings-host-scope'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getCodexHistorySharingDescription,
  getCodexHistorySharingTitle,
  getCodexHistorySharingUnsupported
} from './codex-history-sharing-copy'
import { useCodexHistorySharingHostSetting } from './use-codex-history-sharing-host-setting'

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
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStore((state) =>
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
      label={getCodexHistorySharingTitle()}
      description={
        setting.state === 'unsupported'
          ? getCodexHistorySharingUnsupported(hostLabel)
          : getCodexHistorySharingDescription()
      }
      checked={enabled}
      disabled={setting.state !== 'ready' || !hostScope.available}
      onChange={() => void update(!enabled)}
    />
  )
}
