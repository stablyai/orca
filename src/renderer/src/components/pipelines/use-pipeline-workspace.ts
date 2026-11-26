import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PipelineAssociation } from '../../../../shared/pipelines/pipeline-association'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

export type PipelineWorkspace = Worktree & {
  instanceId: string
  pipeline: Extract<PipelineAssociation, { engineVersion: 2 }>
}
function isPipelineWorkspace(
  workspace: Worktree | null | undefined
): workspace is PipelineWorkspace {
  return Boolean(
    workspace?.instanceId &&
    workspace.pipeline &&
    'engineVersion' in workspace.pipeline &&
    workspace.pipeline.engineVersion === 2 &&
    workspace.pipeline.projectId === workspace.repoId
  )
}
export function usePipelineWorkspace(
  worktreeId: string | null | undefined,
  enabled = true
): PipelineWorkspace | null {
  return useAppStateValue((state) => {
    if (
      !enabled ||
      !worktreeId ||
      getKnownExecutionHostIdForWorktree(state, worktreeId) !== 'local'
    ) {
      return null
    }
    const workspace = selectWorkspaceByHostTarget(
      state,
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
    )
    return isPipelineWorkspace(workspace) ? workspace : null
  })
}
