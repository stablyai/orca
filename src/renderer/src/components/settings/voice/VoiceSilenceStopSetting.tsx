import { useId } from 'react'
import type { VoiceSettings } from '../../../../../shared/speech-types'
import {
  STOP_AFTER_SILENCE_SECONDS_CHOICES,
  stopAfterSilenceSeconds,
  type StopAfterSilenceSeconds
} from '../../../../../shared/dictation-silence-stop'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatMinutesDuration, uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

const OFF_VALUE = 'off'
// Intl formatter caches key on option identity, so this must be a module constant.
const SECOND_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'second',
  unitDisplay: 'long'
}

const choiceValue = (seconds: StopAfterSilenceSeconds): string =>
  seconds === null ? OFF_VALUE : String(seconds)

type VoiceSilenceStopSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceSilenceStopSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceSilenceStopSettingProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const labelId = useId()
  const label = (seconds: StopAfterSilenceSeconds): string => {
    if (seconds === null) {
      return t('components.settings.voice.silenceStop.off', 'Off')
    }
    return seconds % 60 === 0
      ? formatMinutesDuration(seconds / 60, intlLocale)
      : uiNumberFormat(SECOND_UNIT_FORMAT, intlLocale).format(seconds)
  }

  return (
    <SettingsRow
      label={t('components.settings.voice.silenceStop.label', 'Stop after silence')}
      description={t(
        'components.settings.voice.silenceStop.short',
        'Ends dictation when you stop talking.'
      )}
      labelId={labelId}
      control={
        <Select
          value={choiceValue(stopAfterSilenceSeconds(voiceSettings))}
          onValueChange={(value) =>
            onUpdateVoiceSettings({
              stopAfterSilenceSeconds: value === OFF_VALUE ? null : Number(value)
            })
          }
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STOP_AFTER_SILENCE_SECONDS_CHOICES.map((seconds) => (
              <SelectItem key={choiceValue(seconds)} value={choiceValue(seconds)}>
                {label(seconds)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
