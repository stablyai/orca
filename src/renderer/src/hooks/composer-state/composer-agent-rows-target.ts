import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentMenuRowsTarget } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { ComposerModel } from './composer-model'

export type ComposerAgentRows = {
  target: AgentMenuRowsTarget
  detectionTarget: AgentDetectionTarget | undefined
}

/**
 * The workspace the quick-create agent would start in, named the way the create submit names it.
 * Null where that host is not known until creation (an ephemeral VM): the picker keeps its plain list.
 */
export function resolveComposerAgentRows(state: ComposerModel): ComposerAgentRows | null {
  if (state.isProjectGroupTarget) {
    const group = state.selectedProjectGroup
    return group
      ? {
          target: {
            workspace: {
              kind: 'folder',
              runtimeEnvironmentId: state.folderTargetRuntimeEnvironmentId,
              executionHostId: getNewWorkspaceProjectGroupHostId(group)
            }
          },
          detectionTarget: state.folderTargetAgentDetectionTarget
        }
      : null
  }
  if (!state.resolvedRepoId || (state.ephemeralVmsEnabled && state.selectedEphemeralVmRecipeId)) {
    return null
  }
  const runtimeEnvironmentId = state.selectedRepoRuntimeEnvironmentId?.trim() || null
  const connectionId = state.selectedRepoConnectionId
  const runTarget =
    state.selectedWorkspaceTarget.status === 'ready' ? state.selectedWorkspaceTarget.target : null
  return {
    target: {
      workspace: {
        kind: state.selectedRepoIsGit ? 'git-worktree' : 'folder',
        repoId: state.resolvedRepoId,
        executionHostId: runTarget?.hostId ?? state.selectedRepoExecutionHostId ?? undefined
      }
    },
    // Same inventory host the dialog's own agent list reads.
    detectionTarget: runtimeEnvironmentId
      ? { kind: 'runtime', environmentId: runtimeEnvironmentId }
      : typeof connectionId === 'string'
        ? { kind: 'ssh', connectionId }
        : { kind: 'local' }
  }
}
