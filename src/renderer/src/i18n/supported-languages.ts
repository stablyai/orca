import {
  DEFAULT_UI_LOCALE,
  resolveRendererUiLocale,
  type SupportedUiLocale
} from '../../../shared/ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
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
  { value: UI_LANGUAGE_CHINESE, labelKey: 'settings.appearance.language.chinese' }
]

export function resolveUiLocale(language: UiLanguage): SupportedUiLocale {
  return resolveRendererUiLocale(language)
}
