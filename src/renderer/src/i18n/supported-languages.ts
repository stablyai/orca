import {
  DEFAULT_UI_LOCALE,
  resolveRendererUiLocale,
  type SupportedUiLocale
} from '../../../shared/ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  type UiLanguage
} from '../../../shared/ui-language'

export const DEFAULT_LOCALE = DEFAULT_UI_LOCALE

export const SHOW_UI_LANGUAGE_SETTING = true

export type UiLanguageChoice = {
  value: UiLanguage
  labelKey: string
}

export const UI_LANGUAGE_CHOICES: UiLanguageChoice[] = [
  { value: UI_LANGUAGE_SYSTEM, labelKey: 'settings.appearance.language.system' },
  { value: UI_LANGUAGE_ENGLISH, labelKey: 'settings.appearance.language.english' },
  { value: UI_LANGUAGE_CHINESE, labelKey: 'settings.appearance.language.chinese' },
  { value: UI_LANGUAGE_KOREAN, labelKey: 'settings.appearance.language.korean' },
  { value: UI_LANGUAGE_JAPANESE, labelKey: 'settings.appearance.language.japanese' },
  { value: UI_LANGUAGE_SPANISH, labelKey: 'settings.appearance.language.spanish' }
]

const UI_LANGUAGE_CHOICE_FALLBACKS: Record<UiLanguage, string> = {
  [UI_LANGUAGE_SYSTEM]: 'System',
  [UI_LANGUAGE_ENGLISH]: 'English',
  [UI_LANGUAGE_CHINESE]: '中文（简体）',
  [UI_LANGUAGE_KOREAN]: '한국어',
  [UI_LANGUAGE_JAPANESE]: '日本語',
  [UI_LANGUAGE_SPANISH]: 'Español'
}

export function getUiLanguageChoiceLabel(
  choice: UiLanguageChoice,
  translateFn: (key: string, fallback: string) => string
): string {
  return translateFn(choice.labelKey, UI_LANGUAGE_CHOICE_FALLBACKS[choice.value])
}

export function resolveUiLocale(language: UiLanguage): SupportedUiLocale {
  return resolveRendererUiLocale(language)
}
