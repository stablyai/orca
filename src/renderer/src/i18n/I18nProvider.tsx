import { useEffect, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import { UI_LANGUAGE_SYSTEM } from '../../../shared/ui-language'
import { useAppStore } from '../store'
import { i18n } from './i18n'
import { resolveUiLocale } from './supported-languages'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? UI_LANGUAGE_SYSTEM)
  const locale = resolveUiLocale(uiLanguage)

  useEffect(() => {
    // Why: changeLanguage triggers the lazy locale backend, which fetches the
    // non-English catalog before activating it — so the switch resolves real
    // translations without bundling every locale at startup.
    // Why: no `i18n.language !== locale` guard. At boot the system-locale
    // switch can still be lazy-loading its catalog when the persisted language
    // arrives; i18n.language then still reads as the init default, the guard
    // skips the correction, and the stale switch finishes and wins (UI renders
    // the system language while settings show the persisted one). Calling
    // changeLanguage unconditionally makes i18next's own last-call-wins
    // handling discard the stale in-flight switch.
    void i18n.changeLanguage(locale)
  }, [locale])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
