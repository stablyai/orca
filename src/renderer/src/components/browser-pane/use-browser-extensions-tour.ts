import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import { requestContextualTourWhenReady } from '@/components/contextual-tours/request-contextual-tour-when-ready'

// Why renderer start: "a later visit" means the browser was first opened before this app session.
const SESSION_STARTED_AT =
  typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now()

export type BrowserExtensionsTourEligibilityInput = {
  persistedUIReady: boolean
  extensionsEnabled: boolean
  seenIds: readonly ContextualTourId[]
  tourShownThisSession: boolean
  onboardingVisible: boolean
  autoEligible: boolean | null
  featureInteractions: FeatureInteractionState
  sessionStartedAt: number
}

/**
 * Import keeps the first browser visit: the extensions announcement waits for a later app session,
 * never shares a session with another tour, and shows at most once (seen is stamped on first paint).
 */
export function shouldRequestBrowserExtensionsTour(
  input: BrowserExtensionsTourEligibilityInput
): boolean {
  if (!input.persistedUIReady || !input.extensionsEnabled || input.onboardingVisible) {
    return false
  }
  if (input.seenIds.includes('browser-extensions') || input.tourShownThisSession) {
    return false
  }
  // Auto-tour users still owe the browser tour, whose last step is Import; it goes first.
  if (input.autoEligible === true && !input.seenIds.includes('browser')) {
    return false
  }
  // Someone who already opened the puzzle menu has found the feature.
  if (input.featureInteractions['browser-extensions']) {
    return false
  }
  const firstBrowserVisitAt = input.featureInteractions.browser?.firstInteractedAt
  return firstBrowserVisitAt !== undefined && firstBrowserVisitAt < input.sessionStartedAt
}

/** Requests the one-time extensions callout once the active page has an extensions toolbar. */
export function useBrowserExtensionsTour(enabled: boolean, toolbarReady: boolean): void {
  const eligible = useAppStore(
    (s) =>
      enabled &&
      toolbarReady &&
      s.activeContextualTourId === null &&
      s.activeModal === 'none' &&
      !s.contextualToursBlockingSurfaceVisible &&
      shouldRequestBrowserExtensionsTour({
        persistedUIReady: s.persistedUIReady,
        extensionsEnabled: s.settings?.experimentalBrowserExtensions === true,
        seenIds: s.contextualToursSeenIds,
        tourShownThisSession: s.contextualTourShownThisSession,
        onboardingVisible: s.contextualToursOnboardingVisible,
        autoEligible: s.contextualToursAutoEligible,
        featureInteractions: s.featureInteractions,
        sessionStartedAt: SESSION_STARTED_AT
      })
  )
  useEffect(() => {
    if (!eligible) {
      return
    }
    // Forced like the client-hosted intro so pre-onboarding users get it; the gate above
    // re-applies the seen/session rules that force skips. Retries cover the async toolbar state.
    return requestContextualTourWhenReady({
      id: 'browser-extensions',
      source: 'browser_extensions_visible',
      retryDelayMs: 250,
      shouldContinue: () => {
        const s = useAppStore.getState()
        return (
          !s.contextualToursSeenIds.includes('browser-extensions') &&
          !s.contextualTourShownThisSession
        )
      }
    })
  }, [eligible])
}
