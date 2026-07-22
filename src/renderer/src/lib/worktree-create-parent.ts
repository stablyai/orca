import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
import type { AppState } from '@/store/types'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/types'

// Why: re-validated at submit with the parent picker's rules — the parent can be
// deleted (or the composer switched to another repo/host) while the composer was
// open, and a stale parent must drop the link, not fail or mislink the create.
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
  if (!repo || getWorktreeExecutionHostId(parent, repo) !== getRepoExecutionHostId(repo)) {
    return null
  }
  return parent
}
