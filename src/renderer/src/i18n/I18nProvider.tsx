import { useEffect, useRef, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import { useAppStore } from '../store'
import { i18n } from './i18n'
import { resolveUiLocale } from './supported-languages'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Why: settings arrive async over IPC; until they load we must not apply any
  // language. Falling back to 'system' here used to kick off an OS-locale
  // changeLanguage that raced with (and could permanently override) the
  // persisted preference applied moments later.
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? null)
  const locale = uiLanguage === null ? null : resolveUiLocale(uiLanguage)
  const requestedLocale = useRef<string | null>(null)

  useEffect(() => {
    // Why: track the last *requested* locale instead of checking i18n.language —
    // an in-flight lazy catalog load leaves i18n.language stale, which made the
    // guard skip corrections back to the persisted language.
    if (locale === null || requestedLocale.current === locale) {
      return
    }
    requestedLocale.current = locale
    void i18n.changeLanguage(locale)
  }, [locale])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
