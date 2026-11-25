import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import {
  getCodexHistorySharingDescription,
  getCodexHistorySharingTitle,
  getCodexHistorySharingUnsupported,
  getCodexHistorySharingUpdateFailed
} from './codex-history-sharing-copy'
import { useHostSetting, useSettingsHostLabel } from '../../host-scope/use-host-setting'
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
  const hostLabel = useSettingsHostLabel(hostScope.target)
  // The host that launches Codex owns its history links, so the switch reads and writes that host.
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey: 'codexShareHistoryAcrossAccounts',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getCodexHistorySharingUpdateFailed(hostLabel)
  })
  const enabled = setting.state === 'ready' ? setting.value : true
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
