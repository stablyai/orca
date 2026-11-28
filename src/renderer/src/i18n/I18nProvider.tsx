import { useEffect, useRef, type ReactNode } from 'react'
import { useAppStore } from '../store'
import {
  i18n,
  setRendererPluginLanguagePacks,
  loadRendererUiLanguage,
  RendererLanguageLoadError,
  setRendererTimeFormat
} from './i18n'
import { usePluginLanguagePacks } from '../store/plugins/localization/plugin-language-packs'
import { isPluginUiLanguage } from '../../../shared/i18n/ui-language'
import { normalizeTimeFormatPreference } from '../../../shared/i18n/time-format-preference'
import { initializeLanguageDetection, useLanguageReadiness } from './language-readiness'
import { TranslationScopeProvider } from './translation-scope-provider'

// Sync on store publication so the first render after hydration already uses the saved clock.
setRendererTimeFormat(normalizeTimeFormatPreference(useAppStore.getState().settings?.timeFormat))
const unsubscribeTimeFormat = useAppStore.subscribe((state, prevState) => {
  if (state.settings?.timeFormat !== prevState.settings?.timeFormat) {
    setRendererTimeFormat(normalizeTimeFormatPreference(state.settings?.timeFormat))
  }
})
import.meta.hot?.dispose(() => unsubscribeTimeFormat())

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
    const applyLocale = async (locale: string, error: boolean): Promise<void> => {
      if (cancelled || request !== generation.current) {
        return
      }
      await i18n.changeLanguage(locale)
      if (!cancelled && request === generation.current) {
        useLanguageReadiness.setState({ ready: true, error, loading: false })
      }
    }
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
        await applyLocale(locale, false)
      } catch (error) {
        await detection
        await applyLocale('en', true)
        if (error instanceof RendererLanguageLoadError) {
          try {
            // A slow startup must not leave a successfully loaded saved language on English.
            await applyLocale(await error.completion, false)
          } catch {
            // A failed request stays on English until the user retries.
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uiLanguage, activePack, retryCount, systemLocale])

  // initReactI18next already binds useTranslation to this instance.
  return <TranslationScopeProvider>{children}</TranslationScopeProvider>
}
