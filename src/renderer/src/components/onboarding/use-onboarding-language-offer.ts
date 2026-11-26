import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { getRendererLanguageDetection } from '../../../../shared/i18n/ui-locale'
import { usePluginLanguagePackStore } from '@/store/plugins/localization/plugin-language-packs'
import { isUsablePluginLanguagePack } from '../../../../shared/plugins/languages/plugin-language-pack-coverage'
import { loadLanguagePackCatalog } from '../languages/use-language-pack-catalog'
import { deviceLanguageOffer } from '../languages/device-language-offer'

export type OnboardingLanguageOffer = { locale: string; name: string }

/** Why live store reads: late settings or plugins turned on mid-onboarding still produce the offer. */
export function useOnboardingLanguageOffer(
  lastCompletedStep: number
): OnboardingLanguageOffer | null {
  const [freshOnboarding] = useState(() => lastCompletedStep < 0)
  const settingsEligible = useAppStore(
    (state) =>
      state.settings?.uiLanguage === 'system' &&
      state.settings.pluginSystemEnabled &&
      state.settings.languagePackSuggestionShown !== true
  )
  // Why the fallback: detection publishes asynchronously; the renderer default is good until then.
  const detection =
    useLanguageReadiness((state) => state.detection) ?? getRendererLanguageDetection()
  const detectedTag = detection.status === 'unsupported' ? detection.detectedTag : null
  const eligible = freshOnboarding && settingsEligible && detectedTag !== null
  const [offer, setOffer] = useState<OnboardingLanguageOffer | null>(null)
  useEffect(() => {
    if (!eligible) {
      return
    }
    let active = true
    void loadLanguagePackCatalog().then((catalog) => {
      if (!active || catalog.error) {
        return
      }
      const match = deviceLanguageOffer(
        usePluginLanguagePackStore.getState().entries.filter(isUsablePluginLanguagePack),
        catalog.packs,
        detectedTag
      )
      setOffer(match ? { locale: match.locale, name: match.name } : null)
    })
    return () => {
      active = false
    }
  }, [eligible, detectedTag])
  return eligible ? offer : null
}
