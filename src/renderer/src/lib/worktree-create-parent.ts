import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
import type { AppState } from '@/store/types'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { Repo, Worktree } from '../../../shared/types'

export function canCreateChildWorkspace(args: {
  repo: Pick<Repo, 'kind'> | null | undefined
  branch: Worktree['branch']
  isFolderWorkspace: boolean
}): boolean {
  // Why: a child branches from this worktree's branch, so detached/branchless
  // rows and non-git (folder) workspaces have nothing to base the child on.
  return (
    args.repo != null && isGitRepoKind(args.repo) && !args.isFolderWorkspace && args.branch !== ''
  )
}

// Why: re-validated at submit with the entry gate plus the parent picker's rules —
// the parent can be deleted, go branchless (detached HEAD), or the composer can
// switch repo/host while it was open, and a stale parent must drop the link, not
// fail or mislink the create.
export function resolveWorktreeCreateParent(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
  parentWorktreeId: string,
  repoId: string
): Worktree | null {
  const parent = getIndexedWorktreeById(state.worktreesByRepo, parentWorktreeId)
  if (!parent || parent.repoId !== repoId || parent.isArchived) {
    return null
  }
  const repo = getIndexedRepoMap(state.repos).get(repoId)
  if (
    !repo ||
    getWorktreeExecutionHostId(parent, repo) !== getRepoExecutionHostId(repo) ||
    !canCreateChildWorkspace({
      repo,
      branch: parent.branch,
      isFolderWorkspace: parseWorkspaceKey(parent.id)?.type === 'folder'
    })
  ) {
    return null
  }
  return parent
}
