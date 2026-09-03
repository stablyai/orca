import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { getContextualTour } from '../../../../../shared/contextual-tours'
import {
  getContextualTourRequestDecision,
  hasContextualTourTarget,
  getNextVisibleContextualTourStepIndex,
  getPreviousVisibleContextualTourStepIndex
} from '../../../components/contextual-tours/contextual-tour-gate'
import { hasFeatureInteraction } from '../../../../../shared/feature-interactions'

export function createUiTourActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    contextualToursSeenIds: [],
    contextualToursAutoEligible: null,
    activeContextualTourId: null,
    activeContextualTourStepIndex: 0,
    activeContextualTourSource: null,
    activeContextualTourSourceDetached: false,
    activeContextualTourWasFeaturePreviouslyInteracted: false,
    contextualTourNavigationInteractionSnapshot: {},
    activeContextualTourSuppressed: false,
    contextualTourShownThisSession: false,
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false,
    lastCompletedContextualTourId: null,
    setContextualToursAutoEligible: (eligible) =>
      set((s) => {
        if (s.contextualToursAutoEligible === eligible) {
          return s
        }
        if (typeof window !== 'undefined') {
          window.api.ui.set({ contextualToursAutoEligible: eligible }).catch(console.error)
        }
        return { contextualToursAutoEligible: eligible }
      }),
    setContextualToursOnboardingVisible: (visible) =>
      set((s) =>
        s.contextualToursOnboardingVisible === visible
          ? s
          : { contextualToursOnboardingVisible: visible }
      ),
    setContextualToursBlockingSurfaceVisible: (visible) =>
      set((s) =>
        s.contextualToursBlockingSurfaceVisible === visible
          ? s
          : { contextualToursBlockingSurfaceVisible: visible }
      ),
    requestContextualTour: (id, source, wasFeaturePreviouslyInteracted, options) =>
      set((s) => {
        const tour = getContextualTour(id)
        const decision = getContextualTourRequestDecision({
          tour,
          persistedUIReady: s.persistedUIReady,
          autoEligible: options?.force === true || s.contextualToursAutoEligible === true,
          onboardingVisible: s.contextualToursOnboardingVisible,
          seenIds: options?.force === true ? [] : s.contextualToursSeenIds,
          sessionConsumed: options?.force === true ? false : s.contextualTourShownThisSession,
          activeTourId: s.activeContextualTourId,
          activeModal: s.activeModal,
          blockingSurfaceVisible: s.contextualToursBlockingSurfaceVisible,
          targetExists: hasContextualTourTarget
        })
        if (decision.kind !== 'start') {
          if (s.contextualTourNavigationInteractionSnapshot[id] === undefined) {
            return s
          }
          const { [id]: _consumed, ...remainingNavigationSnapshot } =
            s.contextualTourNavigationInteractionSnapshot
          void _consumed
          return { contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot }
        }
        const navigationSnapshot = s.contextualTourNavigationInteractionSnapshot[id]
        const { [id]: _consumed, ...remainingNavigationSnapshot } =
          s.contextualTourNavigationInteractionSnapshot
        void _consumed
        return {
          activeContextualTourId: id,
          activeContextualTourStepIndex: decision.stepIndex,
          activeContextualTourSource: source,
          activeContextualTourSourceDetached: false,
          activeContextualTourWasFeaturePreviouslyInteracted:
            wasFeaturePreviouslyInteracted ??
            navigationSnapshot ??
            hasFeatureInteraction(s.featureInteractions, id),
          contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot,
          activeContextualTourSuppressed: false,
          contextualTourShownThisSession: true,
          lastCompletedContextualTourId: null
        }
      }),
    suppressContextualTour: (id, source) =>
      set((s) => {
        if (
          s.activeContextualTourId !== id ||
          s.activeContextualTourSource !== source ||
          s.activeContextualTourSourceDetached
        ) {
          return s
        }
        return s.activeContextualTourSuppressed ? s : { activeContextualTourSuppressed: true }
      }),
    detachContextualTourSource: (id, source) =>
      set((s) => {
        if (s.activeContextualTourId !== id || s.activeContextualTourSource !== source) {
          return s
        }
        return s.activeContextualTourSourceDetached
          ? s
          : { activeContextualTourSourceDetached: true }
      }),
    advanceContextualTour: () =>
      set((s) => {
        if (!s.activeContextualTourId) {
          return s
        }
        const tour = getContextualTour(s.activeContextualTourId)
        const nextStepIndex = getNextVisibleContextualTourStepIndex({
          tour,
          currentStepIndex: s.activeContextualTourStepIndex,
          targetExists: hasContextualTourTarget
        })
        if (nextStepIndex !== null) {
          return { activeContextualTourStepIndex: nextStepIndex }
        }
        // Why: browser step 3's target lives in a closed menu until that step is active.
        if (
          s.activeContextualTourId === 'browser' &&
          s.activeContextualTourStepIndex + 1 < tour.steps.length
        ) {
          return { activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1 }
        }
        return s
      }),
    regressContextualTour: () =>
      set((s) => {
        if (!s.activeContextualTourId) {
          return s
        }
        const previousStepIndex = getPreviousVisibleContextualTourStepIndex({
          tour: getContextualTour(s.activeContextualTourId),
          currentStepIndex: s.activeContextualTourStepIndex,
          targetExists: hasContextualTourTarget
        })
        if (previousStepIndex === null) {
          return s
        }
        return { activeContextualTourStepIndex: previousStepIndex }
      }),
    dismissContextualTour: (id) => {
      const activeTourId = get().activeContextualTourId
      if (id && activeTourId !== id) {
        return
      }
      const tourId = id ?? activeTourId
      if (tourId) {
        get().markContextualToursSeen([tourId])
      }
      set((s) => {
        if (id && s.activeContextualTourId !== id) {
          return s
        }
        return {
          activeContextualTourId: null,
          activeContextualTourStepIndex: 0,
          activeContextualTourSource: null,
          activeContextualTourSourceDetached: false,
          activeContextualTourWasFeaturePreviouslyInteracted: false,
          activeContextualTourSuppressed: false,
          lastCompletedContextualTourId: null
        }
      })
    },
    completeContextualTour: (id) => {
      const activeTourId = get().activeContextualTourId
      if (id && activeTourId !== id) {
        return
      }
      const tourId = id ?? activeTourId
      if (tourId) {
        get().markContextualToursSeen([tourId])
      }
      set((s) => {
        if (id && s.activeContextualTourId !== id) {
          return s
        }
        return {
          activeContextualTourId: null,
          activeContextualTourStepIndex: 0,
          activeContextualTourSource: null,
          activeContextualTourSourceDetached: false,
          activeContextualTourWasFeaturePreviouslyInteracted: false,
          activeContextualTourSuppressed: false,
          lastCompletedContextualTourId: tourId ?? null
        }
      })
    },
    cancelContextualTour: (id) =>
      set((s) => {
        const activeTourId = s.activeContextualTourId
        const tourId = id ?? activeTourId
        if (!tourId || (id && activeTourId !== id)) {
          return s
        }
        const alreadyShown = s.contextualToursSeenIds.includes(tourId)
        return {
          activeContextualTourId: null,
          activeContextualTourStepIndex: 0,
          activeContextualTourSource: null,
          activeContextualTourSourceDetached: false,
          activeContextualTourWasFeaturePreviouslyInteracted: false,
          activeContextualTourSuppressed: false,
          lastCompletedContextualTourId: null,
          contextualTourShownThisSession: alreadyShown ? s.contextualTourShownThisSession : false
        }
      }),
    markContextualToursSeen: (ids) =>
      set((s) => {
        if (ids.length === 0) {
          return s
        }
        const current = new Set(s.contextualToursSeenIds)
        let changed = false
        for (const id of ids) {
          if (!current.has(id)) {
            current.add(id)
            changed = true
          }
        }
        if (!changed) {
          return s
        }
        const next = [...current]
        if (typeof window !== 'undefined') {
          window.api.ui.set({ contextualToursSeenIds: next }).catch(console.error)
        }
        return { contextualToursSeenIds: next }
      })
  }
}
