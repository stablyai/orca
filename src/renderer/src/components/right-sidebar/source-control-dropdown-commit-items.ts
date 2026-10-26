// Share commit blockers across Commit, Commit & Push, and Commit & Sync so disabled reasons agree.

import { translate } from '@/i18n/i18n'
import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'

export type CommitDropdownItems = {
  commit: DropdownItem
  commitPush: DropdownItem
  commitSync: DropdownItem
}

export function buildCommitDropdownItems(ctx: DropdownActionContext): CommitDropdownItems {
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
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd',
      'Commit'
    ),
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
      return 'Checking branch status…'
    }
    if (publishBlockedByPRLoading) {
      return 'Checking PR status…'
    }
    if (publishBlockedByMergedPR) {
      return 'PR is already merged'
    }
    if (publishBlockedByDetachedHead) {
      return 'Check out a branch before syncing commits'
    }
    if (!hasUpstream) {
      // Point to the existing Publish Branch primary instead of naming a nonexistent compound action.
      return 'Publish the branch first to sync commits'
    }
    if (shouldForcePushWithLease) {
      return (
        commitDisabledReason ??
        'Use Commit & Force Push — remote only has older copies of local commits'
      )
    }
    return commitDisabledReason ?? 'Commit, then pull and push'
  })()
  const commitSync: DropdownItem = {
    kind: 'commit_sync',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.323bb614aa',
      'Commit & Sync'
    ),
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
