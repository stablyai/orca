import type { AppState } from '../../types'
import type { FeatureInteractionId } from '../../../../../shared/feature-interactions'
import { getContextualTour, isContextualTourStepDone } from '../../../../../shared/contextual-tours'
import { isPausedActionTour } from './ui-slice-tour-actions'
import {
  getNextVisibleContextualTourStepIndex,
  hasContextualTourTarget
} from '../../../components/contextual-tours/contextual-tour-gate'

export function getContextualTourProgressionForFeatureInteraction(
  state: AppState,
  id: FeatureInteractionId
): 'advance' | 'complete' | 'reveal-sidebar-and-advance' | 'reveal-sidebar' | null {
  if (
    state.activeContextualTourId !== 'workspace-agent-sessions' &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen &&
    state.contextualToursStartedThisSession.includes('workspace-agent-sessions') &&
    isPausedActionTour(state, 'workspace-agent-sessions')
  ) {
    // A split that finishes while its tip is paused (no tour, or another one, showing) still opens
    // the sidebar the next tip points at.
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
    targetExists: hasContextualTourTarget,
    isStepDone: (step) => isContextualTourStepDone(step, state.featureInteractions)
  })
  if (nextStepIndex !== null) {
    return 'advance'
  }
  if (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    step.id === 'agent-sessions-split' &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen
  ) {
    return 'reveal-sidebar-and-advance'
  }
  // Completing here would mark the tour seen and drop a next tip whose target isn't measurable yet.
  return getNextVisibleContextualTourStepIndex({
    tour,
    currentStepIndex: state.activeContextualTourStepIndex,
    targetExists: () => true,
    isStepDone: (step) => isContextualTourStepDone(step, state.featureInteractions)
  }) !== null
    ? 'advance'
    : 'complete'
}
