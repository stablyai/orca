// Share commit blockers across Commit, Commit & Push, and Commit & Sync so disabled reasons agree.

import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'

// Desktop localizes these strings; other clients pass their own copy.
export type CommitDropdownCopy = {
  commit: string
  commitSync: string
  checkingBranchStatus: string
  checkingPrStatus: string
  prAlreadyMerged: string
  checkOutBranchToSync: string
  publishBranchFirstToSync: string
  useCommitAndForcePush: string
  commitThenPullPush: string
}

export const ENGLISH_COMMIT_DROPDOWN_COPY: CommitDropdownCopy = {
  commit: 'Commit',
  commitSync: 'Commit & Sync',
  checkingBranchStatus: 'Checking branch status…',
  checkingPrStatus: 'Checking PR status…',
  prAlreadyMerged: 'PR is already merged',
  checkOutBranchToSync: 'Check out a branch before syncing commits',
  publishBranchFirstToSync: 'Publish the branch first to sync commits',
  useCommitAndForcePush: 'Use Commit & Force Push — remote only has older copies of local commits',
  commitThenPullPush: 'Commit, then pull and push'
}

export type CommitDropdownItems = {
  commit: DropdownItem
  commitPush: DropdownItem
  commitSync: DropdownItem
}

export function buildCommitDropdownItems(
  ctx: DropdownActionContext,
  copy: CommitDropdownCopy = ENGLISH_COMMIT_DROPDOWN_COPY
): CommitDropdownItems {
  const {
    globalBusy,
    upstreamLoading,
    hasUpstream,
    hasOpenHostedReview,
    canPushLinkedReviewWithoutUpstream,
    pushBlockedByOpenHostedReviewTarget,
    publishBlockedByMergedPR,
    publishBlockedByPRLoading,
    publishBlockedByDetachedHead,
    behind,
    shouldForcePushWithLease,
    commitDisabledReason,
    canCommit
  } = ctx

  const commit: DropdownItem = {
    kind: 'commit',
    label: copy.commit,
    title: commitDisabledReason ?? 'Commit staged changes',
    disabled: !canCommit
  }

  // Committing changes divergence, so compound labels must omit pre-commit counts.
  const commitPushTitle = upstreamLoading
    ? 'Checking branch status…'
    : publishBlockedByPRLoading
      ? 'Checking PR status…'
      : publishBlockedByMergedPR
        ? 'PR is already merged'
        : publishBlockedByDetachedHead
          ? 'Check out a branch before pushing commits'
          : pushBlockedByOpenHostedReviewTarget
            ? 'Linked review branch target is unavailable'
            : !hasUpstream && !(hasOpenHostedReview && canPushLinkedReviewWithoutUpstream)
              ? 'Publish the branch first to push commits'
              : (commitDisabledReason ??
                (shouldForcePushWithLease
                  ? 'Commit staged changes and force push with lease'
                  : behind > 0
                    ? 'Commit staged changes and try to push'
                    : 'Commit staged changes and push'))
  const commitPush: DropdownItem = {
    kind: 'commit_push',
    label: shouldForcePushWithLease ? 'Commit & Force Push' : 'Commit & Push',
    title: commitPushTitle,
    // Match Push: without upstream, Commit & Push requires a known open-review head.
    disabled:
      globalBusy ||
      upstreamLoading ||
      (!hasUpstream && !(hasOpenHostedReview && canPushLinkedReviewWithoutUpstream)) ||
      publishBlockedByDetachedHead ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR ||
      commitDisabledReason !== null
  }

  const commitSyncTitle = ((): string => {
    if (upstreamLoading) {
      return copy.checkingBranchStatus
    }
    if (publishBlockedByPRLoading) {
      return copy.checkingPrStatus
    }
    if (publishBlockedByMergedPR) {
      return copy.prAlreadyMerged
    }
    if (publishBlockedByDetachedHead) {
      return copy.checkOutBranchToSync
    }
    if (!hasUpstream) {
      // Point to the existing Publish Branch primary instead of naming a nonexistent compound action.
      return copy.publishBranchFirstToSync
    }
    if (shouldForcePushWithLease) {
      return commitDisabledReason ?? copy.useCommitAndForcePush
    }
    return commitDisabledReason ?? copy.commitThenPullPush
  })()
  const commitSync: DropdownItem = {
    kind: 'commit_sync',
    label: copy.commitSync,
    title: commitSyncTitle,
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      publishBlockedByDetachedHead ||
      shouldForcePushWithLease ||
      commitDisabledReason !== null
  }

  return { commit, commitPush, commitSync }
}
