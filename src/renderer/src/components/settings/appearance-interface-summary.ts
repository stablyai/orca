import type { GlobalSettings } from '../../../../shared/types'
import {
  getUiLanguageChoiceLabel,
  SHOW_UI_LANGUAGE_SETTING,
  UI_LANGUAGE_CHOICES
} from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'

function resolveThemeSummary(theme: GlobalSettings['theme']): string {
  if (theme === 'system') {
    return translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
  }
  if (theme === 'light') {
    return translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
  }
  return translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
}

function resolveLanguageSummary(uiLanguage: GlobalSettings['uiLanguage']): string {
  const choice = UI_LANGUAGE_CHOICES.find((entry) => entry.value === uiLanguage)
  if (choice == null) {
    return translate('settings.appearance.language.system', 'System')
  }
  return getUiLanguageChoiceLabel(choice, translate)
}

export function resolveInterfaceSectionSummary(settings: GlobalSettings): string {
  const fontSummary =
    settings.appFontFamily ||
    translate('auto.components.settings.AppearancePane.interfaceDefaultFont', 'Default font')
  if (!SHOW_UI_LANGUAGE_SETTING) {
    return `${resolveThemeSummary(settings.theme)} · ${fontSummary}`
  }
  return `${resolveThemeSummary(settings.theme)} · ${resolveLanguageSummary(settings.uiLanguage)} · ${fontSummary}`
}
