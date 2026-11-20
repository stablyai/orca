import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../../../shared/execution-host/execution-host'
import {
  CLAUDE_FLAGGED_REQUEST_ACTIONS,
  claudeFlaggedRequestAction,
  type ClaudeFlaggedRequestAction
} from '../../../../../../shared/agent-launch/startup/claude-flagged-request-launch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import {
  useHostSettingValue,
  type HostSettingsReply
} from '../../host-scope/use-host-boolean-setting'
import {
  getClaudeFlaggedRequestActionLabel,
  getClaudeFlaggedRequestDescription,
  getClaudeFlaggedRequestTitle,
  getClaudeFlaggedRequestUnsupported,
  getClaudeFlaggedRequestUpdateFailed
} from './claude-flagged-request-copy'

function readHostAction(settings: HostSettingsReply): ClaudeFlaggedRequestAction | undefined {
  return settings.claudeFlaggedRequestAction === undefined
    ? undefined
    : claudeFlaggedRequestAction(settings)
}

/** The host that launches Claude applies the choice, so the select reads and writes that host. */
export function ClaudeFlaggedRequestSetting({
  settings,
  updateSettings,
  hostScope
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  hostScope: SettingsHostScope
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  const hostLabel = hostName ?? getLocalExecutionHostLabel()
  const { setting, update } = useHostSettingValue({
    owner: hostScope.target,
    settingKey: 'claudeFlaggedRequestAction',
    read: readHostAction,
    localValue: claudeFlaggedRequestAction(settings),
    updateLocalSettings: updateSettings,
    updateFailedMessage: getClaudeFlaggedRequestUpdateFailed(hostLabel)
  })
  const action = setting.state === 'ready' ? setting.value : 'switch-model'
  return (
    <SettingsRow
      label={getClaudeFlaggedRequestTitle(t)}
      labelId={labelId}
      description={
        setting.state === 'unsupported'
          ? getClaudeFlaggedRequestUnsupported(hostLabel, t)
          : getClaudeFlaggedRequestDescription(t)
      }
      control={
        <Select
          value={action}
          disabled={setting.state !== 'ready' || !hostScope.available}
          onValueChange={(value) => {
            const next = CLAUDE_FLAGGED_REQUEST_ACTIONS.find((choice) => choice === value)
            if (next && next !== action) {
              void update(next)
            }
          }}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_FLAGGED_REQUEST_ACTIONS.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {getClaudeFlaggedRequestActionLabel(choice, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
