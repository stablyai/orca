import { useEffect, useState } from 'react'
import {
  isPluginUiLanguage,
  normalizeUiLanguage,
  UI_LANGUAGE_NATIVE_NAMES,
  UI_LANGUAGE_SYSTEM,
  type UiLanguage
} from '../../../../shared/i18n/ui-language'
import {
  DEFAULT_UI_LOCALE,
  getRendererLanguageDetection,
  type SupportedUiLocale
} from '../../../../shared/i18n/ui-locale'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

type PreviousUiLanguage = { locale: SupportedUiLocale; name: string; system: boolean }

/** The built-in language "Switch back" restores: System resolves to the device locale, a pack to English. */
function previousUiLanguage(previous: UiLanguage | null | undefined): PreviousUiLanguage {
  const language = normalizeUiLanguage(previous ?? DEFAULT_UI_LOCALE)
  if (isPluginUiLanguage(language)) {
    return { locale: DEFAULT_UI_LOCALE, name: UI_LANGUAGE_NATIVE_NAMES.en, system: false }
  }
  if (language !== UI_LANGUAGE_SYSTEM) {
    return { locale: language, name: UI_LANGUAGE_NATIVE_NAMES[language], system: false }
  }
  const detection = getRendererLanguageDetection()
  const locale = detection.status === 'unsupported' ? DEFAULT_UI_LOCALE : detection.locale
  return { locale, name: UI_LANGUAGE_NATIVE_NAMES[locale], system: true }
}

function hasCatalog(locale: SupportedUiLocale): boolean {
  return locale === DEFAULT_UI_LOCALE || i18n.hasResourceBundle(locale, 'translation')
}

export type PreviousUiLanguageCopy = {
  lang: SupportedUiLocale
  switchBack: string
  community: string
}

/**
 * "Switch back" copy in the language it restores, since the active pack may be partial or broken.
 * English shows until that language's catalog has loaded.
 */
export function usePreviousUiLanguageCopy(
  previous: UiLanguage | null | undefined,
  enabled: boolean,
  publisher: string | null = null
): PreviousUiLanguageCopy {
  const t = useTranslate()
  const target = previousUiLanguage(previous)
  const { locale } = target
  const [loadedLocale, setLoadedLocale] = useState<string | null>(null)
  const loaded = loadedLocale === locale || hasCatalog(locale)
  useEffect(() => {
    if (!enabled || loaded) {
      return
    }
    let live = true
    loadRendererUiLanguage(locale).then(
      () => {
        if (live) {
          setLoadedLocale(locale)
        }
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [enabled, loaded, locale])
  const lng = loaded ? locale : DEFAULT_UI_LOCALE
  return {
    lang: lng,
    switchBack: target.system
      ? t('languages.switchBackToSystem', 'Switch back to {{language}} (System)', {
          lng,
          language: target.name
        })
      : t('languages.switchBackTo', 'Switch back to {{language}}', { lng, language: target.name }),
    community: publisher
      ? t('languages.communityBy', 'Community translation by {{publisher}}.', { lng, publisher })
      : t('languages.communityTranslation', 'Community translation.', { lng })
  }
}
