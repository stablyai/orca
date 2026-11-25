import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { resolveWorktreeExecutionHost } from '../../../../../shared/execution-host/worktree-execution-host-resolution'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { getIndexedRepoExecutionHostLookup } from './repo-owner-index'

type OwnerState = Pick<
  WorktreeRuntimeOwnerState,
  'repos' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
>

export function isChatWorkspace(
  state: OwnerState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const owner = resolveWorktreeExecutionHost(getIndexedRepoExecutionHostLookup(state.repos), {
    repoId,
    hostId:
      executionHostId ??
      (state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : undefined)
  })
  return (
    owner.kind === 'resolved' &&
    state.repos?.some(
      (repo) =>
        repo.id === repoId && repo.chatWorkspace && getRepoExecutionHostId(repo) === owner.hostId
    ) === true
  )
}
