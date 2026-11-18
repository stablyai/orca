import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host/execution-host'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useHostBooleanSetting } from '../host-scope/use-host-boolean-setting'

/** The host that runs a chat continues it, so the switch reads and writes the host picked in Settings. */
export function NativeChatUsageLimitContinueSetting({
  settings,
  hostScope,
  label,
  description
}: {
  settings: GlobalSettings
  hostScope: SettingsHostScope
  label: string
  description: string
}): React.JSX.Element {
  const t = useTranslate()
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  const hostLabel = hostName ?? getLocalExecutionHostLabel()
  const { setting, update } = useHostBooleanSetting({
    owner: hostScope.target,
    settingKey: 'nativeChatAutoContinueAfterUsageLimit',
    localEnabled: settings.nativeChatAutoContinueAfterUsageLimit === true,
    // The throwing variant, so a failed local save shows the toast instead of only logging.
    updateLocalSettings: updateSettingsOrThrow,
    updateFailedMessage: t(
      'components.settings.nativeChat.usageLimitContinueUpdateFailed',
      "Couldn't update the setting on {{host}}.",
      { host: hostLabel }
    )
  })
  const enabled = setting.state === 'ready' && setting.enabled
  return (
    <SettingsSwitchRow
      label={label}
      description={
        setting.state === 'unsupported'
          ? t(
              'components.settings.nativeChat.usageLimitContinueUnsupported',
              'Update Orca on {{host}} to change this setting there.',
              { host: hostLabel }
            )
          : description
      }
      checked={enabled}
      // A paired web client learns its host's value after load; until then it has none to show.
      disabled={
        setting.state !== 'ready' ||
        !hostScope.available ||
        (hostScope.target.kind === 'local' &&
          settings.nativeChatAutoContinueAfterUsageLimit === undefined)
      }
      ariaLabel={t(
        'components.settings.nativeChat.usageLimitContinueToggleLabel',
        'Toggle continuing chats when a usage limit resets'
      )}
      onChange={() => void update(!enabled)}
    />
  )
}
