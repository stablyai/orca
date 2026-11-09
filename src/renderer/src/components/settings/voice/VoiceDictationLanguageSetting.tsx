import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import {
  DICTATION_LANGUAGE_AUTO,
  DICTATION_LANGUAGES,
  engineDictationLanguage
} from '../../../../../shared/dictation-language'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { languageDisplayName, uiCollator } from '@/i18n/ui-intl-formatters'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsSearchableSelect } from '../form-controls/SettingsSearchableSelect'

// Intl formatter caches key on option identity, so this must be a module constant.
const NAME_COLLATOR: Intl.CollatorOptions = { sensitivity: 'base' }

function describeLanguageSetting(
  model: SpeechModelManifest | undefined,
  language: string,
  modelIgnoresLanguage: boolean,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (model && modelIgnoresLanguage) {
    return t(
      'components.settings.voice.dictationLanguage.ignored',
      '{{model}} only transcribes the languages it was built for, so it ignores this setting.',
      { model: model.label }
    )
  }
  if (model && language !== DICTATION_LANGUAGE_AUTO && !engineDictationLanguage(model, language)) {
    return t(
      'components.settings.voice.dictationLanguage.unsupported',
      "{{model}} doesn't support {{language}}, so it detects the language itself.",
      { model: model.label, language: languageDisplayName(language, intlLocale) }
    )
  }
  return t(
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const modelIgnoresLanguage = selectedModel !== undefined && !selectedModel.dictationLanguages
  const language = voiceSettings.dictationLanguage || DICTATION_LANGUAGE_AUTO
  const choices = selectedModel?.dictationLanguages ?? DICTATION_LANGUAGES
  // Keep a choice the model lacks selectable rather than showing a blank trigger.
  const codes =
    language === DICTATION_LANGUAGE_AUTO || choices.includes(language)
      ? choices
      : [language, ...choices]
  const collator = uiCollator(NAME_COLLATOR, intlLocale)
  const options = codes
    .map((code) => ({ code, name: languageDisplayName(code, intlLocale) }))
    .sort((a, b) => collator.compare(a.name, b.name))
  const label = t('components.settings.voice.dictationLanguage.title', 'Dictation Language')
  const autoLabel = t('components.settings.voice.dictationLanguage.auto', 'Auto-detect')

  return (
    <SettingsRow
      label={label}
      description={describeLanguageSetting(
        selectedModel,
        language,
        modelIgnoresLanguage,
        t,
        intlLocale
      )}
      control={
        <SettingsSearchableSelect
          ariaLabel={label}
          value={language}
          groups={[
            {
              key: 'dictation-languages',
              options: [
                { value: DICTATION_LANGUAGE_AUTO, label: autoLabel },
                ...options.map(({ code, name }) => ({
                  value: code,
                  label: name,
                  keywords: [code]
                }))
              ]
            }
          ]}
          searchPlaceholder={t(
            'auto.components.settings.SettingsSearchableSelect.searchLanguages',
            'Search languages…'
          )}
          disabled={!voiceSettings.enabled || modelIgnoresLanguage}
          onValueChange={(value) => onUpdateVoiceSettings({ dictationLanguage: value })}
        />
      }
    />
  )
}
