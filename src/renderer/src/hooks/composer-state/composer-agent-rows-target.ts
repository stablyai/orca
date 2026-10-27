import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentMenuRowsTarget } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { ComposerModel } from './composer-model'

export type ComposerAgentRows = {
  target: AgentMenuRowsTarget
  detectionTarget: AgentDetectionTarget | undefined
}

/** Resolve the same launch workspace as submit; unknown pre-create hosts such as ephemeral VMs keep the unfiltered agent list. */
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
    detectionTarget: runtimeEnvironmentId
      ? { kind: 'runtime', environmentId: runtimeEnvironmentId }
      : typeof connectionId === 'string'
        ? { kind: 'ssh', connectionId }
        : { kind: 'local' }
  }
}
