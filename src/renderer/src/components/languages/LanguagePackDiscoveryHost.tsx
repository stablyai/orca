import React, { Suspense, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useAppStore } from '@/store'

const LazyLanguagePackDiscoveryController = lazyWithRetry(
  () =>
    import('./LanguagePackDiscoveryController').then((module) => ({
      default: module.LanguagePackDiscoveryController
    })),
  { reloadKey: 'language-pack-discovery-controller' }
)

export function LanguagePackDiscoveryHost({
  onboardingKnown,
  onboardingVisible
}: {
  onboardingKnown: boolean
  onboardingVisible: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const detectionStatus = useLanguageReadiness((state) => state.detection?.status)
  const [suppressedForOnboarding, setSuppressedForOnboarding] = useState(onboardingVisible)
  if (onboardingVisible && !suppressedForOnboarding) {
    setSuppressedForOnboarding(true)
  }

  const eligible =
    onboardingKnown &&
    persistedUIReady &&
    !onboardingVisible &&
    !suppressedForOnboarding &&
    !settings?.languagePackSuggestionShown &&
    settings?.uiLanguage === 'system' &&
    Boolean(settings.pluginSystemEnabled) &&
    detectionStatus === 'unsupported'
  const shouldMount = useLatchedOpen(eligible)

  if (!shouldMount) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <LazyLanguagePackDiscoveryController
        onboardingKnown={onboardingKnown}
        onboardingVisible={onboardingVisible}
        suppressedForOnboarding={suppressedForOnboarding}
      />
    </Suspense>
  )
}
