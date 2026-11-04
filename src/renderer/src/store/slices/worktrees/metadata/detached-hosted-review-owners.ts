import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  currentHostedReviewOwner,
  type HostedReviewOwner
} from '../../../../../../shared/worktree/hosted-review-branch-ownership'
import {
  deleteCopyTombstones,
  moveCopyTombstones,
  reviewClearTombstoneKey
} from './worktree-copy-review-clear'

// Why its own map: what a copy proved before it detached must outlive the detached row, keyed
// like tombstones (id plus copy owner) so a same-path twin on another host keeps its own proof.
const detachedOwnersByCopy = new Map<
  string,
  { instanceId: string | undefined; owner: HostedReviewOwner }
>()

/** The copy's ownership before this observation; remembers it while `nextBranch` is detached. */
export function observeDetachedHostedReviewOwner(
  worktreeId: string,
  copyOwner: string,
  worktree: Worktree,
  nextBranch: string
): HostedReviewOwner | undefined {
  const key = reviewClearTombstoneKey(worktreeId, copyOwner)
  const owner = currentHostedReviewOwner(worktree, detachedOwnersByCopy.get(key))
  if (nextBranch === '' && owner && owner.kind !== 'unknown') {
    detachedOwnersByCopy.set(key, { instanceId: worktree.instanceId, owner })
  } else {
    detachedOwnersByCopy.delete(key)
  }
  return owner
}

/** An attached listing row proves the copy reattached; its old proof must not judge a later detach. */
export function forgetDetachedOwner(worktreeId: string, copyOwner: string): void {
  detachedOwnersByCopy.delete(reviewClearTombstoneKey(worktreeId, copyOwner))
}

/** Every copy's proof for `worktreeId`, or all of them. */
export function deleteDetachedOwners(worktreeId?: string): void {
  if (worktreeId === undefined) {
    detachedOwnersByCopy.clear()
  } else {
    deleteCopyTombstones(detachedOwnersByCopy, worktreeId)
  }
}

export function moveDetachedOwners(oldWorktreeId: string, newWorktreeId: string): void {
  moveCopyTombstones(detachedOwnersByCopy, oldWorktreeId, newWorktreeId)
}
