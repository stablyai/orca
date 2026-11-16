import { useAppStore } from '@/store'
import { getContextualTour } from '../../../../shared/feature-education/contextual-tours/contextual-tours'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'
import { selectOpenWorkspaceComposerData } from '@/lib/workspace/creation/workspace-composer-pane-surface'

export function openWorkspaceCreationComposerWithTourHandoff(): void {
  const state = useAppStore.getState()
  const hasProjects = state.repos.length > 0

  const shouldHandoffFromAgentSessionsTour =
    hasProjects &&
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    getContextualTour('workspace-agent-sessions').steps[state.activeContextualTourStepIndex]?.id ===
      'agent-sessions-parallel'

  if (shouldHandoffFromAgentSessionsTour && state.activeContextualTourSource) {
    // Complete the final create-button action synchronously so modal cancellation cannot block the composer tour handoff.
    state.detachContextualTourSource('workspace-agent-sessions', state.activeContextualTourSource)
    state.completeContextualTour('workspace-agent-sessions')
  }

  state.openModal('new-workspace-composer', {
    telemetrySource: 'sidebar',
    ...(shouldHandoffFromAgentSessionsTour
      ? { contextualTourSource: 'workspace_creation_modal' }
      : {})
  })

  if (!shouldHandoffFromAgentSessionsTour) {
    return
  }

  if (state.contextualToursSeenIds.includes('workspace-creation')) {
    return
  }

  requestContextualTourWhenReady({
    id: 'workspace-creation',
    source: 'workspace_creation_modal',
    wasFeaturePreviouslyInteracted: false,
    waitForActiveTourToClear: true,
    shouldContinue: () => selectOpenWorkspaceComposerData(useAppStore.getState()) !== null
  })
}
