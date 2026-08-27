import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getUiLanguageChoiceLabel,
  SHOW_UI_LANGUAGE_SETTING,
  UI_LANGUAGE_CHOICES
} from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import { isPureBlackVariant } from '../../../../shared/dark-appearance-variant'

function resolveThemeSummary(settings: GlobalSettings): string {
  if (settings.theme === 'light') {
    return translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
  }
  // Why appended rather than replacing: the variant qualifies the theme, and
  // System still resolves per-OS, so the base label has to survive.
  const pureBlackSuffix = isPureBlackVariant(settings.darkAppearanceVariant)
    ? ` · ${translate('settings.appearance.darkAppearance.pureBlack', 'Pure Black')}`
    : ''
  if (settings.theme === 'system') {
    return `${translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')}${pureBlackSuffix}`
  }
  return `${translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')}${pureBlackSuffix}`
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
    return `${resolveThemeSummary(settings)} · ${fontSummary}`
  }
  return `${resolveThemeSummary(settings)} · ${resolveLanguageSummary(settings.uiLanguage)} · ${fontSummary}`
}
