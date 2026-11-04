import type { AppState } from '../../types'
import {
  hasFeatureInteraction,
  type FeatureInteractionId
} from '../../../../../shared/feature-interactions'
import { getContextualTour } from '../../../../../shared/contextual-tours'
import { isPausedActionTour } from './ui-slice-tour-actions'
import {
  getNextVisibleContextualTourStepIndex,
  hasContextualTourTarget
} from '../../../components/contextual-tours/contextual-tour-gate'

export function getContextualTourProgressionForFeatureInteraction(
  state: AppState,
  id: FeatureInteractionId
):
  | 'advance'
  | 'complete'
  | 'reveal-sidebar-and-advance'
  | 'advance-to-next-step'
  | 'reveal-sidebar'
  | null {
  if (
    state.activeContextualTourId !== 'workspace-agent-sessions' &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen &&
    state.contextualToursAutoEligible === true &&
    isPausedActionTour(state, 'workspace-agent-sessions') &&
    !hasFeatureInteraction(state.featureInteractions, id)
  ) {
    // A first split that finishes while its tip is paused (no tour, or another one, showing) still
    // opens the sidebar the next tip points at.
    return 'reveal-sidebar'
  }
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
  // Completing here would mark the tour seen and drop a next tip whose target isn't measurable yet.
  return state.activeContextualTourStepIndex + 1 < tour.steps.length
    ? 'advance-to-next-step'
    : 'complete'
}
