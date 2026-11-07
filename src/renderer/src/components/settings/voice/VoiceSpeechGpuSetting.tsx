import type { VoiceSettings } from '../../../../../shared/speech-types'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { translate } from '@/i18n/i18n'

type VoiceSpeechGpuSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceSpeechGpuSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceSpeechGpuSettingProps): React.JSX.Element {
  const label = translate('auto.components.settings.VoicePane.speechGpuLabel', 'Use GPU')
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.VoicePane.speechGpuDescription',
            'Recognize speech on the graphics card when it works, and on the CPU when it fails. Turn off if dictation freezes or restarts your computer.'
          )}
        </p>
      </div>
      <Switch
        checked={voiceSettings.speechGpu !== 'off'}
        aria-label={label}
        onCheckedChange={(checked) =>
          onUpdateVoiceSettings({ speechGpu: checked ? 'auto' : 'off' })
        }
      />
    </div>
  )
}
