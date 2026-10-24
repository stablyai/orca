import type { GlobalSettings } from './global-settings-types'
import { normalizeUiLanguage } from './ui-language'

type PortugueseUiLanguageSettings = Pick<
  GlobalSettings,
  'uiLanguage' | 'uiLanguagePortugueseMigrationApplied'
>

export function migratePortugueseUiLanguageOnLoad(
  settings: Partial<PortugueseUiLanguageSettings> | undefined
): PortugueseUiLanguageSettings {
  return {
    uiLanguage:
      settings?.uiLanguagePortugueseMigrationApplied !== true &&
      settings?.uiLanguage === 'plugin:stablyai.orca-portuguese/pt-BR'
        ? 'pt'
        : normalizeUiLanguage(settings?.uiLanguage),
    uiLanguagePortugueseMigrationApplied: true
  }
}
