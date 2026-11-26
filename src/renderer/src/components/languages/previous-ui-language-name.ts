import {
  isPluginUiLanguage,
  normalizeUiLanguage,
  UI_LANGUAGE_NATIVE_NAMES,
  UI_LANGUAGE_SYSTEM,
  type UiLanguage
} from '../../../../shared/i18n/ui-language'
import { getRendererLanguageDetection } from '../../../../shared/i18n/ui-locale'

/**
 * Untranslated name of the language "Switch back" restores; the active pack may be broken.
 * System names what it resolves to, e.g. "English (System)" when the device locale is unsupported.
 */
export function previousUiLanguageName(previous: UiLanguage | null | undefined): string {
  const language = normalizeUiLanguage(previous ?? 'en')
  if (isPluginUiLanguage(language)) {
    return UI_LANGUAGE_NATIVE_NAMES.en
  }
  if (language !== UI_LANGUAGE_SYSTEM) {
    return UI_LANGUAGE_NATIVE_NAMES[language]
  }
  const detection = getRendererLanguageDetection()
  const resolved = detection.status === 'unsupported' ? 'en' : detection.locale
  return `${UI_LANGUAGE_NATIVE_NAMES[resolved]} (System)`
}
