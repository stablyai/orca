import type { UiLanguage } from './ui-language'

export type UiLanguageSettings = {
  uiLanguage: UiLanguage
  uiLanguageBeforePlugin?: UiLanguage | null
  languagePackSuggestionShown?: boolean
  uiLanguagePortugueseMigrationApplied?: boolean
}
