import type { VoiceSettings } from '../../../../../shared/speech-types'
import {
  DICTATION_AUTO_SEND_DELAYS_MS,
  dictationAutoSendDelayMs
} from '../../../../../shared/dictation-auto-send'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { SettingsRow } from '../form-controls/SettingsFormControls'

// Intl formatter caches key on option identity, so this must be a module constant.
const SECOND_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'second',
  unitDisplay: 'long'
}

type VoiceAutoSendSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceAutoSendSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceAutoSendSettingProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const label = t('components.settings.voice.autoSend.label', 'Send when dictation ends')
  const on = voiceSettings.autoSendAfterDictation === true

  return (
    <SettingsRow
      label={label}
      description={t(
        'components.settings.voice.autoSend.description',
        'Sends what you dictate into a chat after a short pause. Type, click or press Esc to keep it as a draft.'
      )}
      control={
        <div className="flex items-center gap-3">
          {on ? (
            <Select
              value={String(dictationAutoSendDelayMs(voiceSettings))}
              onValueChange={(value) => onUpdateVoiceSettings({ autoSendDelayMs: Number(value) })}
            >
              <SelectTrigger
                size="sm"
                className="min-w-28"
                aria-label={t('components.settings.voice.autoSend.delay', 'Delay before sending')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DICTATION_AUTO_SEND_DELAYS_MS.map((delayMs) => (
                  <SelectItem key={delayMs} value={String(delayMs)}>
                    {uiNumberFormat(SECOND_UNIT_FORMAT, intlLocale).format(delayMs / 1000)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Switch
            checked={on}
            aria-label={label}
            onCheckedChange={(checked) =>
              onUpdateVoiceSettings({ autoSendAfterDictation: checked })
            }
          />
        </div>
      }
    />
  )
}
