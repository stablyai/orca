import type React from 'react'
import { useId } from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES,
  NATIVE_CHAT_IDLE_STOP_NEVER
} from '../../../../../shared/native-chat/settings/native-chat-idle-stop'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { formatMinutesDuration } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'

function formatIdleStopMinutes(
  minutes: number,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (minutes === NATIVE_CHAT_IDLE_STOP_NEVER) {
    return t('components.settings.nativeChat.idleStopNever', 'Never')
  }
  return formatMinutesDuration(minutes, intlLocale)
}

type NativeChatIdleStopSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The host whose idle sweep stops its chats' agents. */
  hostScope: SettingsHostScope
  title: string
  description: string
}

export function NativeChatIdleStopSetting({
  settings,
  updateSettings,
  hostScope,
  title,
  description
}: NativeChatIdleStopSettingProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const labelId = useId()
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey: 'nativeChatIdleStopMinutes',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  const minutes = setting.state === 'ready' ? setting.value : null
  // Keep a hand-edited value selectable rather than showing a blank trigger.
  const options =
    minutes === null || NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES.includes(minutes)
      ? NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES
      : [minutes, ...NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES]
  return (
    <SettingsRow
      label={title}
      description={
        setting.state === 'unsupported' ? getHostSettingUnsupportedNote(hostLabel, t) : description
      }
      labelId={labelId}
      control={
        <Select
          value={minutes === null ? '' : String(minutes)}
          disabled={minutes === null || !hostScope.available}
          onValueChange={(value) => void update(Number(value))}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {formatIdleStopMinutes(choice, t, intlLocale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
