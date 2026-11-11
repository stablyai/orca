import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  getUiLanguageChoiceLabel,
  SHOW_UI_LANGUAGE_SETTING,
  UI_LANGUAGE_CHOICES
} from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

function resolveThemeSummary(theme: GlobalSettings['theme'], t: Translate = translate): string {
  if (theme === 'system') {
    return t('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
  }
  if (theme === 'light') {
    return t('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
  }
  return t('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
}

function resolveLanguageSummary(
  uiLanguage: GlobalSettings['uiLanguage'],
  t: Translate = translate
): string {
  const choice = UI_LANGUAGE_CHOICES.find((entry) => entry.value === uiLanguage)
  if (choice == null) {
    return t('settings.appearance.language.system', 'System')
  }
  return getUiLanguageChoiceLabel(choice, translate)
}

export function resolveInterfaceSectionSummary(
  settings: GlobalSettings,
  t: Translate = translate
): string {
  const fontSummary =
    settings.appFontFamily ||
    t('auto.components.settings.AppearancePane.interfaceDefaultFont', 'Default font')
  if (!SHOW_UI_LANGUAGE_SETTING) {
    return `${resolveThemeSummary(settings.theme, t)} · ${fontSummary}`
  }
  return `${resolveThemeSummary(settings.theme, t)} · ${resolveLanguageSummary(settings.uiLanguage, t)} · ${fontSummary}`
}
