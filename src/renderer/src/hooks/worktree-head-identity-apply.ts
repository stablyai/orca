import type { Worktree, WorktreeHeadIdentity } from '../../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

export type WorktreeHeadIdentityApplyDeps = {
  getWorktreesForRepo: (repoId: string) => Worktree[] | undefined
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
}

function findWorktreeByPath(worktrees: Worktree[], worktreePath: string): Worktree | undefined {
  const exact = worktrees.find((worktree) => worktree.path === worktreePath)
  if (exact) {
    return exact
  }
  // Windows separators/casing can differ between worktree-list output and gitdir contents.
  const normalized = normalizeRuntimePathForComparison(worktreePath)
  return worktrees.find(
    (worktree) => normalizeRuntimePathForComparison(worktree.path) === normalized
  )
}

/** Apply status-only head/branch updates to known rows; structural creation/removal belongs to the full listing. */
export function applyWorktreeHeadIdentities(
  data: { repoId: string; identities: WorktreeHeadIdentity[] },
  deps: WorktreeHeadIdentityApplyDeps
): void {
  const worktrees = deps.getWorktreesForRepo(data.repoId)
  if (!worktrees || worktrees.length === 0) {
    return
  }
  for (const identity of data.identities) {
    const worktree = findWorktreeByPath(worktrees, identity.worktreePath)
    if (!worktree) {
      continue
    }
    deps.updateWorktreeGitIdentity(worktree.id, {
      head: identity.head,
      branch: identity.branch
    })
  }
}
