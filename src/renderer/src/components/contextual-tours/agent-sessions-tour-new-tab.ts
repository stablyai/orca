import { useAppStore } from '@/store'
import { getContextualTour } from '../../../../shared/contextual-tours'

/** Finish after the + menu closes so the next lesson follows the selected tab. */
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
