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
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale)
    }
  }, [locale])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
