import { useId } from 'react'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import {
  DICTATION_LANGUAGE_AUTO,
  DICTATION_LANGUAGES,
  dictationLanguagesFor
} from '../../../../../shared/dictation-language'
import { translate } from '@/i18n/i18n'
import { languageDisplayName, uiCollator } from '@/i18n/ui-intl-formatters'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

// Intl formatter caches key on option identity, so this must be a module constant.
const NAME_COLLATOR: Intl.CollatorOptions = { sensitivity: 'base' }

function describeLanguageSetting(
  model: SpeechModelManifest | undefined,
  language: string,
  modelLanguages: readonly string[] | null
): string {
  if (model && !modelLanguages) {
    return translate(
      'components.settings.voice.dictationLanguage.ignored',
      '{{model}} only transcribes the languages it was built for, so it ignores this setting.',
      { model: model.label }
    )
  }
  if (model && language !== DICTATION_LANGUAGE_AUTO && !modelLanguages?.includes(language)) {
    return translate(
      'components.settings.voice.dictationLanguage.unsupported',
      "{{model}} doesn't support {{language}}, so it detects the language itself.",
      { model: model.label, language: languageDisplayName(language) }
    )
  }
  return translate(
    'components.settings.voice.dictationLanguage.description',
    'The language you speak. Auto-detect lets the model work it out each time.'
  )
}

type VoiceDictationLanguageSettingProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceDictationLanguageSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings
}: VoiceDictationLanguageSettingProps): React.JSX.Element {
  const labelId = useId()
  const language = voiceSettings.dictationLanguage || DICTATION_LANGUAGE_AUTO
  const modelLanguages = selectedModel ? dictationLanguagesFor(selectedModel.type) : null
  const choices = modelLanguages ?? DICTATION_LANGUAGES
  // Keep a choice the model lacks selectable rather than showing a blank trigger.
  const codes =
    language === DICTATION_LANGUAGE_AUTO || choices.includes(language)
      ? choices
      : [language, ...choices]
  const collator = uiCollator(NAME_COLLATOR)
  const options = codes
    .map((code) => ({ code, name: languageDisplayName(code) }))
    .sort((a, b) => collator.compare(a.name, b.name))

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label id={labelId}>
          {translate('components.settings.voice.dictationLanguage.title', 'Dictation Language')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {describeLanguageSetting(selectedModel, language, modelLanguages)}
        </p>
      </div>
      <Select
        value={language}
        disabled={!voiceSettings.enabled || (selectedModel !== undefined && !modelLanguages)}
        onValueChange={(value) => onUpdateVoiceSettings({ dictationLanguage: value })}
      >
        <SelectTrigger size="sm" className="min-w-32 shrink-0" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DICTATION_LANGUAGE_AUTO}>
            {translate('components.settings.voice.dictationLanguage.auto', 'Auto-detect')}
          </SelectItem>
          {options.map(({ code, name }) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
