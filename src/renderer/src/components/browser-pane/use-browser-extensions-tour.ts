import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/index'
import { isContextualTourSessionConsumed } from '@/store/slices/ui/ui-slice-tour-actions'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  activeBrowserExtensionsBanner,
  type BrowserExtensionsBannerAssignmentReply
} from '../../../../shared/browser/extensions/browser-extensions-banner'
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

let assignmentRequest: Promise<BrowserExtensionsBannerAssignmentReply['status']> | null = null

/** Mounted panes share one request; a client that cannot ask keeps the default banner. */
function requestBrowserExtensionsBannerAssignment(): Promise<
  BrowserExtensionsBannerAssignmentReply['status']
> {
  assignmentRequest ??= Promise.resolve()
    .then(() => window.api.telemetryAssignBrowserExtensionsBanner())
    .then(
      (reply) => {
        const status = reply?.status
        return status === 'active' || status === 'deferred' || status === 'not_ready'
          ? status
          : 'not_enrolled'
      },
      () => 'not_enrolled' as const
    )
    .finally(() => {
      assignmentRequest = null
    })
  return assignmentRequest
}

/** Requests the one-time extensions callout once the active page has an extensions toolbar. */
export function useBrowserExtensionsTour(enabled: boolean, toolbarReady: boolean): void {
  // 'assign': main has not yet said which banner this install follows; 'show': it may be requested.
  const step = useAppStore((s) => {
    const eligible =
      enabled &&
      toolbarReady &&
      s.activeContextualTourId === null &&
      s.activeModal === 'none' &&
      !s.contextualToursBlockingSurfaceVisible &&
      shouldRequestBrowserExtensionsTour({
        persistedUIReady: s.persistedUIReady,
        extensionsEnabled: s.settings?.browserExtensionsEnabled === true,
        seenIds: s.contextualToursSeenIds,
        tourShownThisSession: isContextualTourSessionConsumed(s, 'browser-extensions'),
        onboardingVisible: s.contextualToursOnboardingVisible,
        autoEligible: s.contextualToursAutoEligible,
        featureInteractions: s.featureInteractions,
        sessionStartedAt: SESSION_STARTED_AT
      })
    if (!eligible) {
      return null
    }
    const banner = activeBrowserExtensionsBanner(s.settings?.telemetry?.browserExtensionsBanner)
    return banner === undefined ? 'assign' : banner === 'none' ? null : 'show'
  })
  const [usesDefaultBanner, setUsesDefaultBanner] = useState(false)
  useEffect(() => {
    if (step !== 'assign' || usesDefaultBanner) {
      return
    }
    let disposed = false
    void requestBrowserExtensionsBannerAssignment().then((status) => {
      // An assigned banner arrives through settings; other replies leave this launch without one.
      if (!disposed && status === 'not_enrolled') {
        setUsesDefaultBanner(true)
      }
    })
    return () => {
      disposed = true
    }
  }, [step, usesDefaultBanner])
  const show = step === 'show' || (step === 'assign' && usesDefaultBanner)
  useEffect(() => {
    if (!show) {
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
          !isContextualTourSessionConsumed(s, 'browser-extensions')
        )
      }
    })
  }, [show])
}
