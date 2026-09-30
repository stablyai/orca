import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { useAppStore } from '@/store'

/**
 * Whether the repo owning this worktree opted into submodule rows.
 *
 * Why the renderer resolves it: the `git:status` handler reads the repo record
 * only on its local branch, so an SSH- or runtime-hosted worktree would never
 * pick the setting up. The caller knows the worktree, so the answer is exact
 * here, with no remote path matching.
 */
export function getShowSubmoduleChangesForWorktree(worktreeId: string | null | undefined): boolean {
  if (!worktreeId) {
    return false
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  // Why `?? []`: callers of the refresh paths mock the store with partial state,
  // and a missing slice must read as "not opted in" rather than throw mid-refresh.
  const repos = useAppStore.getState().repos ?? []
  return repos.find((repo) => repo.id === repoId)?.showSubmoduleChanges === true
}
