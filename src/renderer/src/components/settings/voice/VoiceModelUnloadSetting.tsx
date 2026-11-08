import { useId } from 'react'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import {
  UNLOAD_MODEL_AFTER_MINUTES_CHOICES,
  unloadModelAfterMinutes,
  type UnloadModelAfterMinutes
} from '../../../../../shared/voice-model-unload'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { formatMinutesDuration } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

const NEVER_VALUE = 'never'

function choiceValue(minutes: UnloadModelAfterMinutes): string {
  return minutes === null ? NEVER_VALUE : String(minutes)
}

function choiceLabel(
  minutes: UnloadModelAfterMinutes,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (minutes === null) {
    return t('components.settings.voice.modelUnload.never', 'Never')
  }
  if (minutes === 0) {
    return t('components.settings.voice.modelUnload.immediately', 'Immediately')
  }
  return formatMinutesDuration(minutes, intlLocale)
}

type VoiceModelUnloadSettingProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceModelUnloadSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings
}: VoiceModelUnloadSettingProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const labelId = useId()
  const isCloudModel = selectedModel?.provider === 'openai'
  const current = unloadModelAfterMinutes(voiceSettings)

  return (
    <SettingsRow
      label={t('components.settings.voice.modelUnload.title', 'Unload Speech Model')}
      description={
        isCloudModel
          ? t(
              'components.settings.voice.modelUnload.cloud',
              'Cloud models run on the provider’s servers, so nothing stays loaded here.'
            )
          : t(
              'components.settings.voice.modelUnload.description',
              'How long the on-device model stays in memory after you stop dictating. While it is loaded, dictation starts at once; “Immediately” frees the memory, so each dictation waits for the model to load.'
            )
      }
      labelId={labelId}
      control={
        <Select
          value={choiceValue(current)}
          // Choosing before turning voice on lets Immediately avoid the first load.
          disabled={isCloudModel}
          onValueChange={(value) =>
            onUpdateVoiceSettings({
              unloadModelAfterMinutes: value === NEVER_VALUE ? null : Number(value)
            })
          }
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNLOAD_MODEL_AFTER_MINUTES_CHOICES.map((minutes) => (
              <SelectItem key={choiceValue(minutes)} value={choiceValue(minutes)}>
                {choiceLabel(minutes, t, intlLocale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
