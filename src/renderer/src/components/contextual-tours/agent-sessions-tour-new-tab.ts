import { useAppStore } from '@/store'
import { getContextualTour } from '../../../../shared/contextual-tours'

/** Opening the + menu is the new-tab step's lesson, so it completes that step. */
export function advanceAgentSessionsTourPastNewTab(): void {
  const state = useAppStore.getState()
  if (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    getContextualTour('workspace-agent-sessions').steps[state.activeContextualTourStepIndex]?.id ===
      'agent-sessions-new-tab'
  ) {
    state.advanceContextualTour()
  }
}
