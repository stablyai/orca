import type { VoiceSettings } from '../../../../shared/speech-types'
import { DICTATION_AUTO_SEND_DELAYS_MS } from '../../../../shared/constants'
import { resolveDictationAutoSendDelayMs } from '../dictation/dictation-auto-send'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { translate } from '@/i18n/i18n'

type VoiceAutoSendSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

function delayLabel(delayMs: (typeof DICTATION_AUTO_SEND_DELAYS_MS)[number]): string {
  switch (delayMs) {
    case 1000:
      return translate('components.settings.VoiceAutoSendSetting.delay1s', '1 second')
    case 2000:
      return translate('components.settings.VoiceAutoSendSetting.delay2s', '2 seconds')
    case 3000:
      return translate('components.settings.VoiceAutoSendSetting.delay3s', '3 seconds')
    case 5000:
      return translate('components.settings.VoiceAutoSendSetting.delay5s', '5 seconds')
  }
}

export function VoiceAutoSendSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceAutoSendSettingProps): React.JSX.Element {
  const title = translate(
    'components.settings.VoiceAutoSendSetting.title',
    'Send when dictation ends'
  )
  const delayAriaLabel = translate(
    'components.settings.VoiceAutoSendSetting.delayAriaLabel',
    'Delay before sending'
  )

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.settings.VoiceAutoSendSetting.description',
            'After dictating into a chat message box, send the message after a short delay. Type, click away, or press Cancel to keep it as a draft.'
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Select
          value={String(resolveDictationAutoSendDelayMs(voiceSettings.autoSendDelayMs))}
          onValueChange={(value) => onUpdateVoiceSettings({ autoSendDelayMs: Number(value) })}
          disabled={!voiceSettings.enabled || !voiceSettings.autoSendAfterDictation}
        >
          <SelectTrigger size="sm" aria-label={delayAriaLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DICTATION_AUTO_SEND_DELAYS_MS.map((delayMs) => (
              <SelectItem key={delayMs} value={String(delayMs)}>
                {delayLabel(delayMs)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Switch
          checked={voiceSettings.autoSendAfterDictation}
          aria-label={title}
          disabled={!voiceSettings.enabled}
          onCheckedChange={(checked) => onUpdateVoiceSettings({ autoSendAfterDictation: checked })}
        />
      </div>
    </div>
  )
}
