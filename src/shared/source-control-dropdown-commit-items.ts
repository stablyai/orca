// Share commit blockers across Commit, Commit & Push, and Commit & Sync so disabled reasons agree.

import type { CommitDisabledReason } from './source-control-commit-eligibility'
import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'

// Desktop localizes these strings; other clients pass their own copy.
export type CommitDropdownCopy = {
  commit: string
  commitStagedChanges: string
  commitPush: string
  commitForcePush: string
  commitSync: string
  checkingBranchStatus: string
  checkingPrStatus: string
  prAlreadyMerged: string
  checkOutBranchToPush: string
  linkedReviewTargetUnavailable: string
  publishBranchFirstToPush: string
  commitAndForcePush: string
  commitAndTryPush: string
  commitAndPush: string
  checkOutBranchToSync: string
  publishBranchFirstToSync: string
  useCommitAndForcePush: string
  commitThenPullPush: string
  // Eligibility compares the English reasons, so copy translates them only for display.
  commitDisabledReason: (reason: CommitDisabledReason) => string
}

export const ENGLISH_COMMIT_DROPDOWN_COPY: CommitDropdownCopy = {
  commit: 'Commit',
  commitStagedChanges: 'Commit staged changes',
  commitPush: 'Commit & Push',
  commitForcePush: 'Commit & Force Push',
  commitSync: 'Commit & Sync',
  checkingBranchStatus: 'Checking branch status…',
  checkingPrStatus: 'Checking PR status…',
  prAlreadyMerged: 'PR is already merged',
  checkOutBranchToPush: 'Check out a branch before pushing commits',
  linkedReviewTargetUnavailable: 'Linked review branch target is unavailable',
  publishBranchFirstToPush: 'Publish the branch first to push commits',
  commitAndForcePush: 'Commit staged changes and force push with lease',
  commitAndTryPush: 'Commit staged changes and try to push',
  commitAndPush: 'Commit staged changes and push',
  checkOutBranchToSync: 'Check out a branch before syncing commits',
  publishBranchFirstToSync: 'Publish the branch first to sync commits',
  useCommitAndForcePush: 'Use Commit & Force Push — remote only has older copies of local commits',
  commitThenPullPush: 'Commit, then pull and push',
  commitDisabledReason: (reason) => reason
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
  const commitDisabledTitle =
    commitDisabledReason === null ? null : copy.commitDisabledReason(commitDisabledReason)

  const commit: DropdownItem = {
    kind: 'commit',
    label: copy.commit,
    title: commitDisabledTitle ?? copy.commitStagedChanges,
    disabled: !canCommit
  }

  // Committing changes divergence, so compound labels must omit pre-commit counts.
  const commitPushTitle = upstreamLoading
    ? copy.checkingBranchStatus
    : publishBlockedByPRLoading
      ? copy.checkingPrStatus
      : publishBlockedByMergedPR
        ? copy.prAlreadyMerged
        : publishBlockedByDetachedHead
          ? copy.checkOutBranchToPush
          : pushBlockedByOpenHostedReviewTarget
            ? copy.linkedReviewTargetUnavailable
            : !hasUpstream && !(hasOpenHostedReview && canPushLinkedReviewWithoutUpstream)
              ? copy.publishBranchFirstToPush
              : (commitDisabledTitle ??
                (shouldForcePushWithLease
                  ? copy.commitAndForcePush
                  : behind > 0
                    ? copy.commitAndTryPush
                    : copy.commitAndPush))
  const commitPush: DropdownItem = {
    kind: 'commit_push',
    label: shouldForcePushWithLease ? copy.commitForcePush : copy.commitPush,
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
      return commitDisabledTitle ?? copy.useCommitAndForcePush
    }
    return commitDisabledTitle ?? copy.commitThenPullPush
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
