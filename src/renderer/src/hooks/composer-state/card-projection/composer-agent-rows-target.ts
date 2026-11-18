import '@/lib/workspace/creation/new-workspace-project-options'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type { AgentMenuRowsTarget } from '@/components/agent/launch-menu/new-tab-agent-menu-model'
import type { ComposerModel } from '../composer-model'

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
              executionHostId: getRepoExecutionHostId(group)
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
