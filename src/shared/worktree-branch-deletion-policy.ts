import type { WorktreeMeta } from './types'
import { normalizeLocalBranchRef } from './git-default-base-ref'

/** `checkout-drift`: the checkout moved off the branch Orca created, so the branch isn't Orca's to delete. */
export type WorktreeBranchRetention = 'delete' | 'preexisting-branch' | 'checkout-drift'

export function resolveWorktreeBranchRetention(
  meta: Pick<WorktreeMeta, 'preserveBranchOnDelete' | 'createdBranch'> | null | undefined,
  currentBranch: string | null | undefined
): WorktreeBranchRetention {
  if (meta?.preserveBranchOnDelete === true) {
    return 'preexisting-branch'
  }
  const createdBranch = meta?.createdBranch ? normalizeLocalBranchRef(meta.createdBranch) : ''
  const checkedOutBranch = normalizeLocalBranchRef(currentBranch ?? '')
  // Both sides must be known: detached HEAD reports no branch, and metadata predating
  // createdBranch would otherwise preserve every branch it can't verify.
  if (createdBranch && checkedOutBranch && createdBranch !== checkedOutBranch) {
    return 'checkout-drift'
  }
  return 'delete'
}
