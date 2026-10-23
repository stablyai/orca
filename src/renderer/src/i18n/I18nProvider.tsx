import { useEffect, useRef, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { useAppStore } from '../store'
import { i18n, setRendererPluginLanguagePacks, loadRendererUiLanguage } from './i18n'
import { usePluginLanguagePacks } from '../store/plugin-language-packs'
import { initializeLanguageDetection, useLanguageReadiness } from './language-readiness'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? null)
  const packs = usePluginLanguagePacks()
  const retryCount = useLanguageReadiness((state) => state.retryCount)
  const systemLocale = useLanguageReadiness((state) =>
    uiLanguage === 'system' ? state.detection?.locale : null
  )
  const generation = useRef(0)

  useEffect(() => {
    setRendererPluginLanguagePacks(packs)
  }, [packs])

  useEffect(() => {
    if (uiLanguage === null) {
      return
    }
    const request = ++generation.current
    let cancelled = false
    useLanguageReadiness.setState({ loading: true })
    void (async () => {
      const detection = initializeLanguageDetection()
      try {
        if (uiLanguage === 'system') {
          await detection
          if (cancelled || request !== generation.current) {
            return
          }
        }
        const [, locale] = await Promise.all([detection, loadRendererUiLanguage(uiLanguage)])
        if (cancelled || request !== generation.current) {
          return
        }
        await i18n.changeLanguage(locale)
        if (!cancelled && request === generation.current) {
          useLanguageReadiness.setState({ ready: true, error: false, loading: false })
        }
      } catch {
        await detection
        if (!cancelled && request === generation.current) {
          await i18n.changeLanguage('en')
          if (!cancelled && request === generation.current) {
            useLanguageReadiness.setState({ ready: true, error: true, loading: false })
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uiLanguage, packs, retryCount, systemLocale])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
