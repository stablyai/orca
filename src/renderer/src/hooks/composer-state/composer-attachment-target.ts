import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import type { ComposerModel } from './composer-model'

type TargetInput = Pick<
  ComposerModel,
  | 'selectedProjectGroup'
  | 'selectedRepoPath'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoSettings'
  | 'connectionId'
> & { selectedRepo: Pick<Repo, 'id'> | undefined }

export function resolveComposerAttachmentTarget(input: TargetInput) {
  const group = input.selectedProjectGroup
  const hostId = group ? getRepoExecutionHostId(group) : input.selectedRepoExecutionHostId
  const host = parseExecutionHostId(hostId)
  const repoPath = input.selectedRepoPath ?? null
  return {
    hostId,
    path: group ? group.parentPath : repoPath,
    // Why: a paired server resolves files.* by worktree id; a bare path never matches one (#16558).
    worktreeId:
      !group && input.selectedRepo && repoPath
        ? getRepoMainWorktreeId({ id: input.selectedRepo.id, path: repoPath })
        : null,
    connectionId: group
      ? host?.kind === 'runtime'
        ? null
        : (group.connectionId ?? null)
      : input.connectionId,
    settings: {
      ...input.selectedRepoSettings,
      activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
    }
  }
}
