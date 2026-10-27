import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'
import {
  describeFastForwardCount,
  describePullCount,
  describePushCount,
  describeSyncCounts,
  formatCountLabel,
  formatManualForcePushTitle,
  formatRebaseBaseRef,
  formatSyncLabel,
  formatUnpublishedForcePushTitle
} from './source-control-dropdown-labels'

// Desktop localizes these strings; other clients pass their own copy.
export type RemoteDropdownCopy = {
  rebaseFromNamedBase: (baseRef: string) => string
  rebaseFromBase: string
  rebaseChooseRemoteBase: string
  rebaseDirtyHint: string
  rebaseWithLatestFrom: (baseRef: string) => string
  fetch: string
  fetchTitle: string
}

export const ENGLISH_REMOTE_DROPDOWN_COPY: RemoteDropdownCopy = {
  rebaseFromNamedBase: (baseRef) => `Rebase from ${baseRef}`,
  rebaseFromBase: 'Rebase from Base',
  rebaseChooseRemoteBase: 'Choose a remote base branch to rebase from',
  rebaseDirtyHint: 'Try rebasing; git may require committing or stashing local changes first',
  rebaseWithLatestFrom: (baseRef) => `Rebase current branch with latest commits from ${baseRef}`,
  fetch: 'Fetch',
  fetchTitle: 'Fetch from remote without merging'
}

export type RemoteDropdownItems = {
  push: DropdownItem
  forcePush: DropdownItem
  pull: DropdownItem
  fastForward: DropdownItem
  sync: DropdownItem
  rebase: DropdownItem
  fetch: DropdownItem
  publish: DropdownItem
}

export function buildRemoteDropdownItems(
  ctx: DropdownActionContext,
  copy: RemoteDropdownCopy = ENGLISH_REMOTE_DROPDOWN_COPY
): RemoteDropdownItems {
  const {
    upstreamStatus,
    branchCommitsAhead,
    canPushLinkedReviewWithoutUpstream,
    rebaseBaseRef,
    hasDirtyLocalChanges,
    globalBusy,
    upstreamLoading,
    hasUpstream,
    canPushUntrackedHostedReview,
    pushBlockedByOpenHostedReviewTarget,
    publishBlockedByMergedPR,
    publishBlockedByPRLoading,
    publishBlockedByOpenHostedReview,
    publishBlockedByDetachedHead,
    ahead,
    behind,
    shouldForcePushWithLease,
    pushLabelCount,
    forcePushTitle
  } = ctx

  const push: DropdownItem = {
    kind: 'push',
    label: formatCountLabel('Push', ahead),
    title: publishBlockedByDetachedHead
      ? 'Check out a branch before pushing commits'
      : pushBlockedByOpenHostedReviewTarget
        ? 'Linked review branch target is unavailable'
        : upstreamLoading
          ? 'Push this branch and set an upstream if needed'
          : canPushUntrackedHostedReview
            ? 'Push updates to the linked review branch'
            : !hasUpstream
              ? 'Push this branch and set an upstream if needed'
              : shouldForcePushWithLease
                ? 'Try a regular push; git may require force push'
                : behind > 0 && ahead > 0
                  ? 'Push local commits; git may require syncing first'
                  : ahead === 0
                    ? `Nothing to push${upstreamStatus?.upstreamName ? ` to ${upstreamStatus.upstreamName}` : ''}`
                    : describePushCount(ahead),
    // Push can set upstream and coexist with force-with-lease; detached HEAD and unknown review targets still block it.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const forcePush: DropdownItem = {
    kind: 'force_push',
    label: formatCountLabel('Force Push', pushLabelCount),
    title: publishBlockedByDetachedHead
      ? 'Check out a branch before force pushing commits'
      : pushBlockedByOpenHostedReviewTarget
        ? 'Linked review branch target is unavailable'
        : upstreamLoading
          ? formatUnpublishedForcePushTitle(branchCommitsAhead)
          : !hasUpstream
            ? formatUnpublishedForcePushTitle(branchCommitsAhead)
            : pushLabelCount === 0
              ? `Nothing to force push${upstreamStatus?.upstreamName ? ` to ${upstreamStatus.upstreamName}` : ''}`
              : shouldForcePushWithLease
                ? forcePushTitle
                : formatManualForcePushTitle(pushLabelCount, behind, upstreamStatus?.upstreamName),
    // Match Push target safety; force-with-lease must not push the wrong review head.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const pull: DropdownItem = {
    kind: 'pull',
    label: formatCountLabel('Pull', behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : publishBlockedByDetachedHead
            ? 'Check out a branch before pulling commits'
            : !hasUpstream
              ? 'Publish the branch first to pull commits'
              : shouldForcePushWithLease
                ? 'Nothing new to pull — remote only has older copies of local commits'
                : behind === 0
                  ? 'Nothing to pull'
                  : describePullCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const fastForward: DropdownItem = {
    kind: 'fast_forward',
    label: formatCountLabel('Fast-forward', behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : publishBlockedByDetachedHead
            ? 'Check out a branch before fast-forwarding'
            : !hasUpstream
              ? 'Publish the branch first to fast-forward'
              : shouldForcePushWithLease
                ? 'Nothing new to fast-forward — remote only has older copies of local commits'
                : behind === 0
                  ? 'Nothing to fast-forward'
                  : ahead > 0
                    ? 'Try a fast-forward pull; git may reject local commits'
                    : describeFastForwardCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const sync: DropdownItem = {
    kind: 'sync',
    label: formatSyncLabel('Sync', ahead, behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : publishBlockedByDetachedHead
            ? 'Check out a branch before syncing commits'
            : !hasUpstream
              ? 'Publish the branch first to sync commits'
              : shouldForcePushWithLease
                ? 'Use Force Push — remote only has older copies of local commits'
                : ahead === 0 && behind === 0
                  ? 'Branch is up to date'
                  : describeSyncCounts(ahead, behind),
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      publishBlockedByDetachedHead ||
      shouldForcePushWithLease
  }

  const rebaseBaseLabel = rebaseBaseRef ? formatRebaseBaseRef(rebaseBaseRef) : null
  const hasRemoteBaseRef = rebaseBaseLabel?.includes('/') === true
  const rebase: DropdownItem = {
    kind: 'rebase_base',
    label: rebaseBaseLabel ? copy.rebaseFromNamedBase(rebaseBaseLabel) : copy.rebaseFromBase,
    title: ((): string => {
      if (!rebaseBaseLabel || !hasRemoteBaseRef) {
        return copy.rebaseChooseRemoteBase
      }
      if (hasDirtyLocalChanges) {
        return copy.rebaseDirtyHint
      }
      return copy.rebaseWithLatestFrom(rebaseBaseLabel)
    })(),
    disabled: globalBusy || !rebaseBaseRef || !hasRemoteBaseRef
  }

  const fetch: DropdownItem = {
    kind: 'fetch',
    label: copy.fetch,
    title: copy.fetchTitle,
    disabled: globalBusy
  }

  const publish: DropdownItem = {
    kind: 'publish',
    label:
      publishBlockedByMergedPR || publishBlockedByPRLoading
        ? 'PR Status'
        : publishBlockedByOpenHostedReview
          ? 'Linked Review'
          : publishBlockedByDetachedHead
            ? 'No Branch'
            : 'Publish Branch',
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : publishBlockedByOpenHostedReview
            ? canPushLinkedReviewWithoutUpstream
              ? 'Linked review branch already exists'
              : 'Linked review branch target is unavailable'
            : publishBlockedByDetachedHead
              ? 'Check out a branch before publishing commits'
              : hasUpstream
                ? 'Branch is already published'
                : 'Publish this branch to origin',
    disabled:
      globalBusy ||
      upstreamLoading ||
      hasUpstream ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR ||
      publishBlockedByOpenHostedReview ||
      publishBlockedByDetachedHead
  }

  return { push, forcePush, pull, fastForward, sync, rebase, fetch, publish }
}
