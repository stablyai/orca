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
    // Models without a language hint either know one language or work out which of theirs you speak.
    return model.languages.length === 1
      ? t(
          'components.settings.voice.dictationLanguage.alwaysUses',
          'The language you speak. {{model}} always uses {{language}}.',
          { model: model.label, language: languageDisplayName(model.languages[0], intlLocale) }
        )
      : t(
          'components.settings.voice.dictationLanguage.detectsItself',
          'The language you speak. {{model}} detects it by itself.',
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
    'components.settings.voice.dictationLanguage.rated',
    'The language you speak. Quality is rated for it.'
  )
}

type VoiceDictationLanguageSettingProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  className?: string
}

export function VoiceDictationLanguageSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings,
  className
}: VoiceDictationLanguageSettingProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const modelIgnoresLanguage = selectedModel !== undefined && !selectedModel.dictationLanguages
  const language = voiceSettings.dictationLanguage || DICTATION_LANGUAGE_AUTO
  // Every language, even ones this model lacks: the choice also rates the other models.
  const codes = [
    ...new Set([
      ...(language === DICTATION_LANGUAGE_AUTO ? [] : [language]),
      ...DICTATION_LANGUAGES,
      ...(selectedModel?.dictationLanguages ?? [])
    ])
  ]
  const collator = uiCollator(NAME_COLLATOR, intlLocale)
  const options = codes
    .map((code) => ({ code, name: languageDisplayName(code, intlLocale) }))
    .sort((a, b) => collator.compare(a.name, b.name))
  const label = t('components.settings.voice.language.title', 'Language')
  const autoLabel = t('components.settings.voice.dictationLanguage.auto', 'Auto-detect')

  return (
    <SettingsRow
      className={className}
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
          fitValue
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
          onValueChange={(value) => onUpdateVoiceSettings({ dictationLanguage: value })}
        />
      }
    />
  )
}
