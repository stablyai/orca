import type { UiLanguage } from './ui-language'
import type { TimeFormatPreference } from './time-format-preference'

export type UiLanguageSettings = {
  uiLanguage: UiLanguage
  uiLanguageBeforePlugin?: UiLanguage | null
  languagePackSuggestionShown?: boolean
  uiLanguagePortugueseMigrationApplied?: boolean
  timeFormat?: TimeFormatPreference
}
