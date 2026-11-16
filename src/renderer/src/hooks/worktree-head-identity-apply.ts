import type {
  DetectedWorktreeListResult,
  Worktree,
  WorktreeHeadIdentity
} from '../../../shared/worktree/types'
import { branchName } from '@/lib/source-control/branches/branch-name'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

export type WorktreeHeadIdentityApplyDeps = {
  getWorktreesForRepo: (repoId: string) => Worktree[] | undefined
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null },
    ownerHostId: ExecutionHostId | null
  ) => void
}

function findWorktreeByPath<T extends Worktree>(
  worktrees: T[],
  worktreePath: string
): T | undefined {
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
    // Why: this watcher reads this machine's checkouts, never a same-path twin on another host.
    deps.updateWorktreeGitIdentity(
      worktree.id,
      { head: identity.head, branch: identity.branch },
      LOCAL_EXECUTION_HOST_ID
    )
  }
}

/** Patch detected rows, which only listings refresh; returns the input when nothing moved. */
export function patchDetectedWorktreeHeadIdentities(
  detected: DetectedWorktreeListResult | undefined,
  identities: WorktreeHeadIdentity[]
): DetectedWorktreeListResult | undefined {
  if (!detected) {
    return detected
  }
  let worktrees = detected.worktrees
  for (const identity of identities) {
    const worktree = findWorktreeByPath(worktrees, identity.worktreePath)
    const branch = identity.branch ?? ''
    if (!worktree || (worktree.head === identity.head && worktree.branch === branch)) {
      continue
    }
    // Keep branch-derived names in step, as the listing would.
    const displayName =
      branch && worktree.displayName === branchName(worktree.branch)
        ? branchName(branch)
        : worktree.displayName
    worktrees = worktrees.map((row) =>
      row === worktree ? { ...row, head: identity.head, branch, displayName } : row
    )
  }
  return worktrees === detected.worktrees ? detected : { ...detected, worktrees }
}
