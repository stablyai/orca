import type { DropdownItem } from './source-control-dropdown-item-types'
import type { DropdownActionContext } from './source-control-dropdown-action-context'
import {
  formatCountLabel,
  formatRebaseBaseRef,
  formatSyncLabel
} from './source-control-dropdown-labels'
import {
  ENGLISH_REMOTE_DROPDOWN_COPY,
  type RemoteDropdownCopy
} from './source-control-dropdown-remote-copy'

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
    pushLabelCount
  } = ctx

  const push: DropdownItem = {
    kind: 'push',
    label: formatCountLabel(copy.push, ahead),
    title: publishBlockedByDetachedHead
      ? copy.checkOutBranchToPush
      : pushBlockedByOpenHostedReviewTarget
        ? copy.linkedReviewTargetUnavailable
        : upstreamLoading
          ? copy.pushAndSetUpstream
          : canPushUntrackedHostedReview
            ? copy.pushToLinkedReview
            : !hasUpstream
              ? copy.pushAndSetUpstream
              : shouldForcePushWithLease
                ? copy.tryRegularPush
                : behind > 0 && ahead > 0
                  ? copy.pushMayNeedSync
                  : ahead === 0
                    ? upstreamStatus?.upstreamName
                      ? copy.nothingToPushTo(upstreamStatus.upstreamName)
                      : copy.nothingToPush
                    : copy.pushCount(ahead),
    // Push can set upstream and coexist with force-with-lease; detached HEAD and unknown review targets still block it.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const forcePush: DropdownItem = {
    kind: 'force_push',
    label: formatCountLabel(copy.forcePush, pushLabelCount),
    title: publishBlockedByDetachedHead
      ? copy.checkOutBranchToForcePush
      : pushBlockedByOpenHostedReviewTarget
        ? copy.linkedReviewTargetUnavailable
        : upstreamLoading
          ? copy.unpublishedForcePush(branchCommitsAhead)
          : !hasUpstream
            ? copy.unpublishedForcePush(branchCommitsAhead)
            : pushLabelCount === 0
              ? upstreamStatus?.upstreamName
                ? copy.nothingToForcePushTo(upstreamStatus.upstreamName)
                : copy.nothingToForcePush
              : shouldForcePushWithLease
                ? copy.forcePushWithLease(branchCommitsAhead, upstreamStatus?.upstreamName)
                : copy.manualForcePush(pushLabelCount, behind, upstreamStatus?.upstreamName),
    // Match Push target safety; force-with-lease must not push the wrong review head.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const pull: DropdownItem = {
    kind: 'pull',
    label: formatCountLabel(copy.pull, behind),
    title: upstreamLoading
      ? copy.checkingBranchStatus
      : publishBlockedByPRLoading
        ? copy.checkingPrStatus
        : publishBlockedByMergedPR
          ? copy.prAlreadyMerged
          : publishBlockedByDetachedHead
            ? copy.checkOutBranchToPull
            : !hasUpstream
              ? copy.publishBranchFirstToPull
              : shouldForcePushWithLease
                ? copy.nothingNewToPull
                : behind === 0
                  ? copy.nothingToPull
                  : copy.pullCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const fastForward: DropdownItem = {
    kind: 'fast_forward',
    label: formatCountLabel(copy.fastForward, behind),
    title: upstreamLoading
      ? copy.checkingBranchStatus
      : publishBlockedByPRLoading
        ? copy.checkingPrStatus
        : publishBlockedByMergedPR
          ? copy.prAlreadyMerged
          : publishBlockedByDetachedHead
            ? copy.checkOutBranchToFastForward
            : !hasUpstream
              ? copy.publishBranchFirstToFastForward
              : shouldForcePushWithLease
                ? copy.nothingNewToFastForward
                : behind === 0
                  ? copy.nothingToFastForward
                  : ahead > 0
                    ? copy.tryFastForwardPull
                    : copy.fastForwardCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const sync: DropdownItem = {
    kind: 'sync',
    label: formatSyncLabel(copy.sync, ahead, behind),
    title: upstreamLoading
      ? copy.checkingBranchStatus
      : publishBlockedByPRLoading
        ? copy.checkingPrStatus
        : publishBlockedByMergedPR
          ? copy.prAlreadyMerged
          : publishBlockedByDetachedHead
            ? copy.checkOutBranchToSync
            : !hasUpstream
              ? copy.publishBranchFirstToSync
              : shouldForcePushWithLease
                ? copy.useForcePushToSync
                : ahead === 0 && behind === 0
                  ? copy.branchUpToDate
                  : copy.syncCounts(ahead, behind),
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
        ? copy.publishPrStatus
        : publishBlockedByOpenHostedReview
          ? copy.publishLinkedReview
          : publishBlockedByDetachedHead
            ? copy.publishNoBranch
            : copy.publishBranch,
    title: upstreamLoading
      ? copy.checkingBranchStatus
      : publishBlockedByPRLoading
        ? copy.checkingPrStatus
        : publishBlockedByMergedPR
          ? copy.prAlreadyMerged
          : publishBlockedByOpenHostedReview
            ? canPushLinkedReviewWithoutUpstream
              ? copy.linkedReviewBranchExists
              : copy.linkedReviewTargetUnavailable
            : publishBlockedByDetachedHead
              ? copy.checkOutBranchToPublish
              : hasUpstream
                ? copy.branchAlreadyPublished
                : copy.publishToOrigin,
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
