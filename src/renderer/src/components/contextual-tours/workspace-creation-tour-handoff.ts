import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { getContextualTour } from '../../../../shared/contextual-tours'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'

function isAgentSessionsParallelStepActive(state: AppState): boolean {
  return (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    getContextualTour('workspace-agent-sessions').steps[state.activeContextualTourStepIndex]?.id ===
      'agent-sessions-parallel'
  )
}

// Clicking the final tip's + is that step's action, whether it opens the composer or creates a folder workspace directly.
export function completeAgentSessionsParallelStep(): void {
  const state = useAppStore.getState()
  if (!isAgentSessionsParallelStepActive(state) || !state.activeContextualTourSource) {
    return
  }
  // Complete synchronously so modal cancellation cannot block the composer tour handoff.
  state.detachContextualTourSource('workspace-agent-sessions', state.activeContextualTourSource)
  state.completeContextualTour('workspace-agent-sessions')
}

export function openWorkspaceCreationComposerWithTourHandoff(options?: {
  initialRepoId?: string
  initialWorkspaceTarget?: WorkspaceCreationTargetHint
}): void {
  const state = useAppStore.getState()
  const hasProjects = state.repos.length > 0

  const shouldHandoffFromAgentSessionsTour = hasProjects && isAgentSessionsParallelStepActive(state)

  if (shouldHandoffFromAgentSessionsTour) {
    completeAgentSessionsParallelStep()
  }

  state.openModal('new-workspace-composer', {
    telemetrySource: 'sidebar',
    ...(options?.initialRepoId ? { initialRepoId: options.initialRepoId } : {}),
    ...(options?.initialWorkspaceTarget
      ? { initialWorkspaceTarget: options.initialWorkspaceTarget }
      : {}),
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
    shouldContinue: () => useAppStore.getState().activeModal === 'new-workspace-composer'
  })
}
