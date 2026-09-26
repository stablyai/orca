import { useEffect, useRef, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import { useAppStore } from '../store'
import { getIntlLocale, i18n, setRendererPluginLanguagePacks } from './i18n'
import { resolveUiLocale } from './supported-languages'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { usePluginLanguagePacks } from '../store/plugin-language-packs'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Why: settings arrive async over IPC; until they load we must not apply any
  // language. Falling back to 'system' here used to kick off an OS-locale
  // changeLanguage that raced with (and could permanently override) the
  // persisted preference applied moments later.
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePacks()
  const selectedPluginLanguage = pluginLanguagePacks.find((pack) => pack.id === uiLanguage)
  const locale =
    uiLanguage === null
      ? null
      : (selectedPluginLanguage?.resourceLanguage ??
        (isPluginUiLanguage(uiLanguage) ? 'en' : resolveUiLocale(uiLanguage)))
  const requestedLocale = useRef<string | null>(null)

  useEffect(() => {
    setRendererPluginLanguagePacks(pluginLanguagePacks)
    requestedLocale.current = null
  }, [pluginLanguagePacks])

  useEffect(() => {
    // Why: CSS text-transform: uppercase/lowercase only applies Turkish-correct
    // dotted/dotless I casing when an ancestor's lang attribute says tr/az —
    // without this, "değişiklikler" uppercases to "DEĞIŞIKLIKLER" instead of
    // "DEĞİŞİKLİKLER". Sync <html lang> to the active locale on every change.
    const applyDocumentLang = (): void => {
      document.documentElement.lang = getIntlLocale()
    }
    applyDocumentLang()
    i18n.on('languageChanged', applyDocumentLang)
    return () => {
      i18n.off('languageChanged', applyDocumentLang)
    }
  }, [])

  useEffect(() => {
    // Why: track the last *requested* locale instead of checking i18n.language —
    // an in-flight lazy catalog load leaves i18n.language stale, which made the
    // guard skip corrections back to the persisted language.
    if (locale === null || requestedLocale.current === locale) {
      return
    }
    requestedLocale.current = locale
    void i18n.changeLanguage(locale)
  }, [locale, pluginLanguagePacks])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
