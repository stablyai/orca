import { DEFAULT_UI_LOCALE, resolveRendererUiLocale } from '../../../shared/ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_FRENCH,
  UI_LANGUAGE_GERMAN,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_RUSSIAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_TURKISH,
  UI_LANGUAGE_NATIVE_NAMES,
  type BuiltInUiLanguage,
  type UiLanguage
} from '../../../shared/ui-language'

export const DEFAULT_LOCALE = DEFAULT_UI_LOCALE

export const SHOW_UI_LANGUAGE_SETTING = true

export type UiLanguageChoice = {
  value: BuiltInUiLanguage
  labelKey: string
}

export const UI_LANGUAGE_CHOICES: UiLanguageChoice[] = [
  { value: UI_LANGUAGE_SYSTEM, labelKey: 'settings.appearance.language.system' },
  { value: UI_LANGUAGE_ENGLISH, labelKey: 'settings.appearance.language.english' },
  { value: UI_LANGUAGE_CHINESE, labelKey: 'settings.appearance.language.chinese' },
  {
    value: UI_LANGUAGE_CHINESE_TRADITIONAL,
    labelKey: 'settings.appearance.language.chineseTraditional'
  },
  { value: UI_LANGUAGE_KOREAN, labelKey: 'settings.appearance.language.korean' },
  { value: UI_LANGUAGE_JAPANESE, labelKey: 'settings.appearance.language.japanese' },
  { value: UI_LANGUAGE_SPANISH, labelKey: 'settings.appearance.language.spanish' },
  { value: UI_LANGUAGE_FRENCH, labelKey: 'settings.appearance.language.french' },
  { value: UI_LANGUAGE_PORTUGUESE, labelKey: 'settings.appearance.language.portuguese' },
  { value: UI_LANGUAGE_RUSSIAN, labelKey: 'settings.appearance.language.russian' },
  { value: UI_LANGUAGE_TURKISH, labelKey: 'settings.appearance.language.turkish' },
  { value: UI_LANGUAGE_GERMAN, labelKey: 'settings.appearance.language.german' }
]

export function getUiLanguageChoiceLabel(
  choice: UiLanguageChoice,
  translateFn: (key: string, fallback: string) => string
): string {
  return translateFn(choice.labelKey, UI_LANGUAGE_NATIVE_NAMES[choice.value])
}

export function resolveUiLocale(language: UiLanguage): string {
  return resolveRendererUiLocale(language)
}

export function getUiLanguageNativeLabel(language: BuiltInUiLanguage): string {
  return UI_LANGUAGE_NATIVE_NAMES[language]
}
