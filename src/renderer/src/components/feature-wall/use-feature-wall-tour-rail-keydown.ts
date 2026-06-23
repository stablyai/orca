import { useCallback } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import {
  FEATURE_WALL_WORKFLOWS,
  type FeatureWallWorkflow
} from '../../../../shared/feature-wall-workflows'
import {
  getFeatureWallRailNavigationTarget,
  type FeatureWallRailNavigationKey
} from './feature-wall-rail-navigation'

const FEATURE_WALL_TOUR_NAVIGATION_KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'Home', 'End'])

export function useFeatureWallTourRailKeydown({
  railRefs,
  onSelectWorkflow
}: {
  railRefs: RefObject<(HTMLButtonElement | null)[]>
  onSelectWorkflow: (workflow: FeatureWallWorkflow) => void
}): (event: KeyboardEvent<HTMLButtonElement>, index: number) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
      if (!FEATURE_WALL_TOUR_NAVIGATION_KEYS.has(event.key)) {
        return
      }
      event.preventDefault()
      const nextIndex = getFeatureWallRailNavigationTarget({
        currentIndex: index,
        key: event.key as FeatureWallRailNavigationKey,
        itemCount: FEATURE_WALL_WORKFLOWS.length
      })
      const nextWorkflow = FEATURE_WALL_WORKFLOWS[nextIndex]
      if (!nextWorkflow) {
        return
      }
      onSelectWorkflow(nextWorkflow)
      railRefs.current[nextIndex]?.focus()
    },
    [onSelectWorkflow, railRefs]
  )
}
