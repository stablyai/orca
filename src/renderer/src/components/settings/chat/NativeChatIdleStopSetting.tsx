import type React from 'react'
import { useId } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES,
  NATIVE_CHAT_IDLE_STOP_NEVER,
  nativeChatIdleStopMinutes
} from '../../../../../shared/native-chat/native-chat-idle-stop'
import { translate } from '@/i18n/i18n'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

// Intl formatter caches key on option identity, so these must be module constants.
const MINUTE_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'minute',
  unitDisplay: 'long'
}
const HOUR_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'hour',
  unitDisplay: 'long'
}

function formatIdleStopMinutes(minutes: number): string {
  if (minutes === NATIVE_CHAT_IDLE_STOP_NEVER) {
    return translate('components.settings.nativeChat.idleStopNever', 'Never')
  }
  return minutes % 60 === 0
    ? uiNumberFormat(HOUR_UNIT_FORMAT).format(minutes / 60)
    : uiNumberFormat(MINUTE_UNIT_FORMAT).format(minutes)
}

type NativeChatIdleStopSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  title: string
  description: string
}

export function NativeChatIdleStopSetting({
  settings,
  updateSettings,
  title,
  description
}: NativeChatIdleStopSettingProps): React.JSX.Element {
  const labelId = useId()
  const minutes = nativeChatIdleStopMinutes(settings)
  // Keep a hand-edited value selectable rather than showing a blank trigger.
  const options = NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES.includes(minutes)
    ? NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES
    : [minutes, ...NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES]
  return (
    <SettingsRow
      label={title}
      description={description}
      labelId={labelId}
      control={
        <Select
          value={String(minutes)}
          onValueChange={(value) => updateSettings({ nativeChatIdleStopMinutes: Number(value) })}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {formatIdleStopMinutes(choice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
