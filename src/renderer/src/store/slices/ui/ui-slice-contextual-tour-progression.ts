import type { AppState } from '../../types'
import type { FeatureInteractionId } from '../../../../../shared/feature-interactions'
import { getContextualTour } from '../../../../../shared/contextual-tours'
import {
  getNextVisibleContextualTourStepIndex,
  hasContextualTourTarget
} from '../../../components/contextual-tours/contextual-tour-gate'

export function getContextualTourProgressionForFeatureInteraction(
  state: AppState,
  id: FeatureInteractionId
): 'advance' | 'complete' | 'reveal-sidebar-and-advance' | null {
  if (!state.activeContextualTourId) {
    return null
  }
  const tour = getContextualTour(state.activeContextualTourId)
  const step = tour.steps[state.activeContextualTourStepIndex]
  if (step?.advanceOnFeatureInteraction !== id) {
    return null
  }
  const nextStepIndex = getNextVisibleContextualTourStepIndex({
    tour,
    currentStepIndex: state.activeContextualTourStepIndex,
    targetExists: hasContextualTourTarget
  })
  if (nextStepIndex !== null) {
    return 'advance'
  }
  if (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    state.activeContextualTourStepIndex === 0 &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen
  ) {
    return 'reveal-sidebar-and-advance'
  }
  return 'complete'
}
