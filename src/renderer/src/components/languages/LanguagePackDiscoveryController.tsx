import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { toast, useSonner } from 'sonner'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useAppStore } from '@/store'
import { usePluginLanguagePacks } from '@/store/plugins/localization/plugin-language-packs'
import {
  isNotificationCardStackOccupied,
  useNotificationCardStackOccupied
} from '@/lib/notifications/notification-card-layout-vars'
import {
  deviceLanguageOffer,
  offerSummary,
  type DeviceLanguageOffer
} from './device-language-offer'
import { useLanguageOfferAction } from './use-language-offer-action'
import { useLanguagePackCatalog } from './use-language-pack-catalog'
import { LanguagePackSuggestionToast } from './LanguagePackSuggestionToast'
import {
  useLanguageSuggestionSurfaceBlocked,
  isLanguageSuggestionSurfaceBlocked
} from './use-language-suggestion-surface'

const SUGGESTION_ID = 'language-pack-discovery'
let shownThisSession = false

export function LanguagePackDiscoveryController({
  onboardingKnown,
  onboardingVisible,
  suppressedForOnboarding
}: {
  onboardingKnown: boolean
  onboardingVisible: boolean
  suppressedForOnboarding: boolean
}): null {
  const settings = useAppStore((state) => state.settings)
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const activeModal = useAppStore((state) => state.activeModal)
  const activeView = useAppStore((state) => state.activeView)
  const detection = useLanguageReadiness((state) => state.detection)
  const cardsVisible = useNotificationCardStackOccupied()
  const surfaceBlocked = useLanguageSuggestionSurfaceBlocked()
  const { toasts } = useSonner()
  const installed = usePluginLanguagePacks()
  const activeToast = useRef(false)
  const eligible =
    onboardingKnown &&
    persistedUIReady &&
    !onboardingVisible &&
    !settings?.languagePackSuggestionShown &&
    settings?.uiLanguage === 'system' &&
    settings.pluginSystemEnabled &&
    detection?.status === 'unsupported'
  const catalog = useLanguagePackCatalog(eligible)
  const detectedTag = detection?.detectedTag ?? null
  // Why memoized: the offer gates the quiet-period timer, which must not restart every render.
  const recommendation = useMemo(
    () => deviceLanguageOffer(installed, catalog.packs, detectedTag),
    [installed, catalog.packs, detectedTag]
  )
  const action = useLanguageOfferAction()
  // The offer the visible toast shows; null once it is closed.
  const [shown, setShown] = useState<DeviceLanguageOffer | null>(null)
  const [attempted, setAttempted] = useState(false)
  const toastError = shown && attempted && !action.progress ? action.errorFor(shown) : null
  // Why effect events: sonner holds the rendered toast, so its handlers must read current state.
  const acceptOffer = useEffectEvent((offer: DeviceLanguageOffer) => {
    setAttempted(true)
    void action.accept(offer).then((switched) => {
      // Why close on success: the "Now using" toast takes over from here.
      if (switched) {
        toast.dismiss(SUGGESTION_ID)
      }
    })
  })
  const anotherToast = toasts.some((entry) => entry.id !== SUGGESTION_ID)
  const blocked =
    surfaceBlocked ||
    cardsVisible ||
    anotherToast ||
    activeModal !== 'none' ||
    activeView === 'settings' ||
    onboardingVisible

  useEffect(() => {
    // Why only the start is gated: once visible, the one-time suggestion stays until answered.
    if (!eligible || blocked || !recommendation || shownThisSession || suppressedForOnboarding) {
      return
    }
    const timer = window.setTimeout(() => {
      const current = useAppStore.getState()
      if (
        current.settings?.languagePackSuggestionShown ||
        current.settings?.uiLanguage !== 'system' ||
        current.activeModal !== 'none' ||
        current.activeView === 'settings' ||
        isLanguageSuggestionSurfaceBlocked() ||
        isNotificationCardStackOccupied() ||
        toast.getToasts().some((entry) => entry.id !== SUGGESTION_ID)
      ) {
        return
      }
      shownThisSession = true
      activeToast.current = true
      setShown(recommendation)
      void current.updateSettings({ languagePackSuggestionShown: true }).catch(() => undefined)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [blocked, eligible, recommendation, suppressedForOnboarding])

  // Re-issuing with the same id updates the visible toast in place with progress or an error.
  useEffect(() => {
    if (!shown) {
      return
    }
    const summary = offerSummary(shown)
    toast.custom(
      (toastId) => (
        <LanguagePackSuggestionToast
          offer={summary}
          progress={action.progress}
          error={toastError}
          onClose={() => toast.dismiss(toastId)}
          onAccept={() => acceptOffer(shown)}
        />
      ),
      {
        id: SUGGESTION_ID,
        // Why no timeout: it waits for a quiet moment and shows once, so let the user decide.
        duration: Infinity,
        closeButton: false,
        unstyled: true,
        onDismiss: () => {
          activeToast.current = false
          setShown(null)
        }
      }
    )
  }, [shown, action.progress, toastError])

  useEffect(
    () => () => {
      if (activeToast.current) {
        toast.dismiss(SUGGESTION_ID)
      }
    },
    []
  )
  return null
}
