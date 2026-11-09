import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import { isContextualTourSessionConsumed } from '@/store/slices/ui/ui-slice-tour-actions'
import { hasFeatureInteraction } from '../../../../../../shared/feature-interactions'
import { isProjectSectionGroupKey } from '../../../../../../shared/sidebar-list/group-keys'

const TOUR_ID = 'projects-collapse-all'
const SOURCE = 'project_header_collapsed'

export function useProjectsCollapseAllAnnouncement(enabled: boolean): (groupKey: string) => void {
  useEffect(() => {
    if (!enabled) {
      useAppStore.getState().suppressContextualTour(TOUR_ID, SOURCE)
    }
    return () => useAppStore.getState().suppressContextualTour(TOUR_ID, SOURCE)
  }, [enabled])

  return useCallback(
    (groupKey: string) => {
      const state = useAppStore.getState()
      if (
        !enabled ||
        !isProjectSectionGroupKey(groupKey) ||
        !state.collapsedGroups.has(groupKey) ||
        state.contextualToursSeenIds.includes(TOUR_ID) ||
        hasFeatureInteraction(state.featureInteractions, TOUR_ID) ||
        isContextualTourSessionConsumed(state, TOUR_ID)
      ) {
        return
      }
      // Attempt only during the related action; blocked tips wait for another manual collapse.
      state.requestContextualTour(TOUR_ID, SOURCE, false, { force: true })
    },
    [enabled]
  )
}
