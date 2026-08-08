import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

// Why: Radix Select reserves '' for clearing, so auto-detect needs a sentinel.
const AUTO_DETECT_VALUE = 'auto'

// Native names stay untranslated so every speaker can find their language
// whatever the current interface locale is.
const TRANSCRIPTION_LANGUAGES: readonly { code: string; nativeName: string }[] = [
  { code: 'cs', nativeName: 'Čeština' },
  { code: 'da', nativeName: 'Dansk' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'hu', nativeName: 'Magyar' },
  { code: 'nl', nativeName: 'Nederlands' },
  { code: 'no', nativeName: 'Norsk' },
  { code: 'pl', nativeName: 'Polski' },
  { code: 'pt', nativeName: 'Português' },
  { code: 'ro', nativeName: 'Română' },
  { code: 'sk', nativeName: 'Slovenčina' },
  { code: 'fi', nativeName: 'Suomi' },
  { code: 'sv', nativeName: 'Svenska' },
  { code: 'tr', nativeName: 'Türkçe' },
  { code: 'el', nativeName: 'Ελληνικά' },
  { code: 'ru', nativeName: 'Русский' },
  { code: 'uk', nativeName: 'Українська' },
  { code: 'ar', nativeName: 'العربية' },
  { code: 'hi', nativeName: 'हिन्दी' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'zh', nativeName: '中文' }
]

type VoiceTranscriptionLanguageSettingProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceTranscriptionLanguageSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings
}: VoiceTranscriptionLanguageSettingProps): React.JSX.Element {
  const label = translate(
    'auto.components.settings.VoiceTranscriptionLanguageSetting.label',
    'Transcription Language'
  )
  const selectedValue = voiceSettings.transcriptionLanguage || AUTO_DETECT_VALUE
  // Why: the language hint is only sent to cloud transcription; local models
  // have a fixed language, so the control would silently do nothing.
  const appliesToSelectedModel = selectedModel?.provider === 'openai'
  const disabled = !voiceSettings.enabled || !appliesToSelectedModel

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">
          {appliesToSelectedModel || !voiceSettings.enabled
            ? translate(
                'auto.components.settings.VoiceTranscriptionLanguageSetting.description',
                'Spoken language sent to cloud transcription. A fixed language improves accuracy over auto-detect.'
              )
            : translate(
                'auto.components.settings.VoiceTranscriptionLanguageSetting.cloudOnly',
                'Applies to cloud (OpenAI) speech models only. The selected local model has a fixed language.'
              )}
        </p>
      </div>
      <Select
        value={selectedValue}
        disabled={disabled}
        onValueChange={(value) => {
          onUpdateVoiceSettings({
            transcriptionLanguage: value === AUTO_DETECT_VALUE ? '' : value
          })
        }}
      >
        <SelectTrigger
          className={`h-7 w-52 shrink-0 text-xs ${disabled ? 'opacity-50' : ''}`}
          aria-label={label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_DETECT_VALUE} className="text-xs">
            {translate(
              'auto.components.settings.VoiceTranscriptionLanguageSetting.autoDetect',
              'Auto-detect'
            )}
          </SelectItem>
          {TRANSCRIPTION_LANGUAGES.map((language) => (
            <SelectItem key={language.code} value={language.code} className="text-xs">
              {`${language.nativeName} (${language.code})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
