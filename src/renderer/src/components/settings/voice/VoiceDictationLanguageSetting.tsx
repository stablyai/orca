import { useId } from 'react'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import {
  DICTATION_LANGUAGE_AUTO,
  DICTATION_LANGUAGES,
  engineDictationLanguage
} from '../../../../../shared/dictation-language'
import { translate } from '@/i18n/i18n'
import { languageDisplayName, uiCollator } from '@/i18n/ui-intl-formatters'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

// Intl formatter caches key on option identity, so this must be a module constant.
const NAME_COLLATOR: Intl.CollatorOptions = { sensitivity: 'base' }

function describeLanguageSetting(
  model: SpeechModelManifest | undefined,
  language: string,
  modelIgnoresLanguage: boolean
): string {
  if (model && modelIgnoresLanguage) {
    return translate(
      'components.settings.voice.dictationLanguage.ignored',
      '{{model}} only transcribes the languages it was built for, so it ignores this setting.',
      { model: model.label }
    )
  }
  if (model && language !== DICTATION_LANGUAGE_AUTO && !engineDictationLanguage(model, language)) {
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
  const modelIgnoresLanguage = selectedModel !== undefined && !selectedModel.dictationLanguages
  const language = voiceSettings.dictationLanguage || DICTATION_LANGUAGE_AUTO
  const choices = selectedModel?.dictationLanguages ?? DICTATION_LANGUAGES
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
    <SettingsRow
      label={translate('components.settings.voice.dictationLanguage.title', 'Dictation Language')}
      description={describeLanguageSetting(selectedModel, language, modelIgnoresLanguage)}
      labelId={labelId}
      control={
        <Select
          value={language}
          disabled={!voiceSettings.enabled || modelIgnoresLanguage}
          onValueChange={(value) => onUpdateVoiceSettings({ dictationLanguage: value })}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
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
      }
    />
  )
}
