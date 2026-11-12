import type { VoiceSettings } from '../../../../../shared/speech-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

type VoiceSpeechGpuSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceSpeechGpuSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceSpeechGpuSettingProps): React.JSX.Element {
  const t = useTranslate()
  const gpuOn = voiceSettings.speechGpu !== 'off'
  return (
    <SettingsSwitchRow
      label={t('auto.components.settings.VoicePane.speechGpuLabel', 'Use GPU')}
      description={t(
        'components.settings.voice.gpu.description',
        'Turn off if dictation freezes your computer.'
      )}
      checked={gpuOn}
      onChange={() => onUpdateVoiceSettings({ speechGpu: gpuOn ? 'off' : 'auto' })}
    />
  )
}
