import {
  AUTO_TRANSCRIPTION_LANGUAGE,
  getModelTranscriptionLanguages,
  SPEECH_TRANSCRIPTION_LANGUAGES,
  type SpeechTranscriptionLanguage
} from '../../../../shared/speech-transcription-languages'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getIntlLocale, translate } from '@/i18n/i18n'

type VoiceTranscriptionLanguageSettingProps = {
  voiceSettings: VoiceSettings
  /** The model dictation will use; its own language support narrows the choices. */
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

function createLanguageNamer(): (language: SpeechTranscriptionLanguage) => string {
  let displayNames: Intl.DisplayNames | null = null
  try {
    displayNames = new Intl.DisplayNames([getIntlLocale()], { type: 'language' })
  } catch {
    displayNames = null
  }
  return (language) => {
    if (language.code === AUTO_TRANSCRIPTION_LANGUAGE) {
      return translate('auto.components.settings.VoiceTranscriptionLanguage.auto', 'Auto-detect')
    }
    // Why: Intl names languages in the UI locale, so the shared English labels need no catalog.
    return displayNames?.of(language.code) ?? language.label
  }
}

function describeLanguageSupport(
  selectedModel: SpeechModelManifest | undefined,
  supported: string[] | null,
  current: SpeechTranscriptionLanguage | undefined,
  nameLanguage: (language: SpeechTranscriptionLanguage) => string
): string {
  if (selectedModel && supported === null) {
    return translate(
      'auto.components.settings.VoiceTranscriptionLanguage.modelPicksLanguage',
      '{{value0}} detects the language itself.',
      { value0: selectedModel.label }
    )
  }
  if (selectedModel && supported && current && current.code !== AUTO_TRANSCRIPTION_LANGUAGE) {
    if (!supported.includes(current.code)) {
      return translate(
        'auto.components.settings.VoiceTranscriptionLanguage.unsupported',
        "{{value0}} doesn't support {{value1}}, so it will auto-detect.",
        { value0: selectedModel.label, value1: nameLanguage(current) }
      )
    }
  }
  return translate(
    'auto.components.settings.VoiceTranscriptionLanguage.description',
    'Hint for cloud models. Auto-detect lets the provider choose.'
  )
}

export function VoiceTranscriptionLanguageSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings
}: VoiceTranscriptionLanguageSettingProps): React.JSX.Element {
  const nameLanguage = createLanguageNamer()
  const current = SPEECH_TRANSCRIPTION_LANGUAGES.find(
    (language) => language.code === voiceSettings.transcriptionLanguage
  )
  const value = current ? current.code : AUTO_TRANSCRIPTION_LANGUAGE
  // Why: no model selected yet means nothing to narrow by, so every language stays available.
  const supported = selectedModel
    ? getModelTranscriptionLanguages(selectedModel.transcriptionLanguages)
    : getModelTranscriptionLanguages('any')
  const label = translate(
    'auto.components.settings.VoiceTranscriptionLanguage.label',
    'Transcription Language'
  )

  return (
    // Why: on narrow windows the control wraps under the text instead of squeezing it.
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <div className="min-w-48 flex-1 space-y-0.5">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">
          {describeLanguageSupport(selectedModel, supported, current, nameLanguage)}
        </p>
      </div>
      <Select
        value={value}
        disabled={!voiceSettings.enabled || supported === null}
        onValueChange={(next) => onUpdateVoiceSettings({ transcriptionLanguage: next })}
      >
        <SelectTrigger size="sm" aria-label={label} className="w-44 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SPEECH_TRANSCRIPTION_LANGUAGES.map((language) => (
            <SelectItem
              key={language.code}
              value={language.code}
              disabled={
                language.code !== AUTO_TRANSCRIPTION_LANGUAGE &&
                supported !== null &&
                !supported.includes(language.code)
              }
            >
              {nameLanguage(language)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
