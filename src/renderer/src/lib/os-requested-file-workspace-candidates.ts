import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { FolderWorkspace, Worktree } from '../../../shared/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import type { WorkspaceCandidate } from './os-requested-file-workspace'

export type WorktreeCandidateSource = Pick<
  Worktree,
  'id' | 'path' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
>

export type FolderWorkspaceCandidateSource = Pick<
  FolderWorkspace,
  'id' | 'folderPath' | 'connectionId' | 'projectGroupId'
>

export type WorkspaceCandidateCollectionState = WorktreeRuntimeOwnerState & {
  worktreesByRepo: Record<string, readonly WorktreeCandidateSource[]>
  folderWorkspaces: readonly FolderWorkspaceCandidateSource[]
}

// Why: the OS always hands over a local path; a remote/SSH-owned candidate whose path string
// happens to contain it must never be adopted — same defect class as the project-group fix.
export function collectLocalWorkspaceCandidates(
  state: WorkspaceCandidateCollectionState
): WorkspaceCandidate[] {
  const candidates: WorkspaceCandidate[] = []
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (getExecutionHostIdForWorktree(state, worktree.id) === LOCAL_EXECUTION_HOST_ID) {
        candidates.push({ id: worktree.id, path: worktree.path })
      }
    }
  }
  for (const folderWorkspace of state.folderWorkspaces) {
    const id = folderWorkspaceKey(folderWorkspace.id)
    if (getExecutionHostIdForWorktree(state, id) === LOCAL_EXECUTION_HOST_ID) {
      candidates.push({ id, path: folderWorkspace.folderPath })
    }
  }
  return candidates
}
