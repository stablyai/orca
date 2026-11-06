import { useEffect, useRef, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { i18n, setRendererPluginLanguagePacks, loadRendererUiLanguage } from './i18n'
import { usePluginLanguagePacks } from '../store/plugin-language-packs'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { initializeLanguageDetection, useLanguageReadiness } from './language-readiness'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? null)
  const packs = usePluginLanguagePacks()
  const retryCount = useLanguageReadiness((state) => state.retryCount)
  const systemLocale = useLanguageReadiness((state) =>
    uiLanguage === 'system' ? state.detection?.locale : null
  )
  const generation = useRef(0)
  // The store keeps unchanged packs by reference, so this changes only when the selected pack's content does.
  const activePack = isPluginUiLanguage(uiLanguage)
    ? packs.find((pack) => pack.id === uiLanguage)
    : undefined

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
  }, [uiLanguage, activePack, retryCount, systemLocale])

  // initReactI18next already binds useTranslation to this instance.
  return <>{children}</>
}
