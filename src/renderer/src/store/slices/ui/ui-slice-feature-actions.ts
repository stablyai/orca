import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  mergeFeatureInteractionState,
  mergeContextualTourSeenIds
} from './ui-slice-hydration-values'
import { getContextualTourProgressionForFeatureInteraction } from './ui-slice-contextual-tour-progression'
import type { FeatureInteractionState } from '../../../../../shared/feature-interactions'

export function createUiFeatureActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    featureTipsSeenIds: [],
    markFeatureTipsSeen: (ids) =>
      set((s) => {
        if (ids.length === 0) {
          return s
        }
        const current = new Set(s.featureTipsSeenIds)
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
        window.api.ui.set({ featureTipsSeenIds: next }).catch(console.error)
        return { featureTipsSeenIds: next }
      }),
    featureInteractions: {},
    recordFeatureInteraction: (id) => {
      let tourProgression: ReturnType<typeof getContextualTourProgressionForFeatureInteraction> =
        null
      let persistPromise = Promise.resolve()
      set((s) => {
        if (!s.persistedUIReady) {
          return s
        }
        tourProgression = getContextualTourProgressionForFeatureInteraction(s, id)
        const existing = s.featureInteractions[id]
        const next: FeatureInteractionState = {
          ...s.featureInteractions,
          [id]: {
            firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
        if (typeof window !== 'undefined') {
          const recordInteraction = window.api.ui.recordFeatureInteraction
          const persist = recordInteraction
            ? recordInteraction(id).then((ui) => {
                set((current) => ({
                  featureInteractions: mergeFeatureInteractionState(
                    current.featureInteractions,
                    ui.featureInteractions
                  ),
                  contextualToursSeenIds: mergeContextualTourSeenIds(
                    current.contextualToursSeenIds,
                    ui.contextualToursSeenIds
                  )
                }))
              })
            : window.api.ui.set({ featureInteractions: next })
          persistPromise = persist.catch(console.error)
        }
        if (tourProgression === 'reveal-sidebar-and-advance') {
          // Why: split can fire from keyboard/menu with the sidebar closed, but the next tour target lives in the sidebar.
          return {
            featureInteractions: next,
            sidebarOpen: true,
            activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1
          }
        }
        return { featureInteractions: next }
      })
      if (tourProgression === 'complete') {
        get().completeContextualTour()
      } else if (tourProgression === 'advance') {
        get().advanceContextualTour()
      }
      return persistPromise
    }
  }
}
