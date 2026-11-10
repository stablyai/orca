import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { VoiceMicrophoneSetting } from './VoiceMicrophoneSetting'
import { VoiceSilenceStopSetting } from './VoiceSilenceStopSetting'

type VoiceInputSettingsProps = {
  voiceSettings: VoiceSettings
  readyModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceInputSettings({
  voiceSettings,
  readyModel,
  onUpdateVoiceSettings
}: VoiceInputSettingsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup title={t('auto.components.settings.VoiceMicrophoneSetting.label', 'Microphone')}>
      <VoiceMicrophoneSetting
        voiceSettings={voiceSettings}
        readyModel={readyModel}
        onUpdateVoiceSettings={onUpdateVoiceSettings}
      />
      <VoiceSilenceStopSetting
        voiceSettings={voiceSettings}
        onUpdateVoiceSettings={onUpdateVoiceSettings}
      />
    </SettingsGroup>
  )
}
