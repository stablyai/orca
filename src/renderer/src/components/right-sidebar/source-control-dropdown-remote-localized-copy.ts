import { translate } from '@/i18n/i18n'
import type { RemoteDropdownCopy } from '../../../../shared/source-control-dropdown-remote-copy'
import {
  localizedFastForwardCount,
  localizedForcePushWithLease,
  localizedManualForcePush,
  localizedPullCount,
  localizedPushCount,
  localizedSyncCounts,
  localizedUnpublishedForcePush
} from './source-control-count-localized-copy'

export function localizedRemoteCopy(): RemoteDropdownCopy {
  return {
    push: translate(
      'auto.components.right.sidebar.source.control.primary.action.95550cff15',
      'Push'
    ),
    forcePush: translate(
      'auto.components.right.sidebar.source.control.primary.action.390abeab93',
      'Force Push'
    ),
    pull: translate(
      'auto.components.right.sidebar.source.control.primary.action.d64292a938',
      'Pull'
    ),
    fastForward: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.fastForward',
      'Fast-forward'
    ),
    sync: translate(
      'auto.components.right.sidebar.source.control.primary.action.795f1509c5',
      'Sync'
    ),
    publishBranch: translate(
      'auto.components.right.sidebar.source.control.primary.action.7b4d02e6b8',
      'Publish Branch'
    ),
    publishPrStatus: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.publishPrStatus',
      'PR Status'
    ),
    publishLinkedReview: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.publishLinkedReview',
      'Linked Review'
    ),
    publishNoBranch: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.publishNoBranch',
      'No Branch'
    ),
    checkingBranchStatus: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.checkingBranchStatus',
      'Checking branch status…'
    ),
    checkingPrStatus: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckingPrStatus',
      'Checking PR status…'
    ),
    prAlreadyMerged: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePrAlreadyMerged',
      'PR is already merged'
    ),
    linkedReviewTargetUnavailable: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    checkOutBranchToPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    pushAndSetUpstream: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePushAndSetUpstream',
      'Push this branch and set an upstream if needed'
    ),
    pushToLinkedReview: translate(
      'auto.components.right.sidebar.source.control.primary.action.1d47e850cf',
      'Push updates to the linked review branch'
    ),
    tryRegularPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleTryRegularPush',
      'Try a regular push; git may require force push'
    ),
    pushMayNeedSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePushMayNeedSync',
      'Push local commits; git may require syncing first'
    ),
    nothingToPushTo: (upstreamName) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPushTo',
        'Nothing to push to {{upstreamName}}',
        { upstreamName }
      ),
    nothingToPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPush',
      'Nothing to push'
    ),
    checkOutBranchToForcePush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToForcePush',
      'Check out a branch before force pushing commits'
    ),
    nothingToForcePushTo: (upstreamName) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToForcePushTo',
        'Nothing to force push to {{upstreamName}}',
        { upstreamName }
      ),
    nothingToForcePush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToForcePush',
      'Nothing to force push'
    ),
    checkOutBranchToPull: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPull',
      'Check out a branch before pulling commits'
    ),
    publishBranchFirstToPull: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToPull',
      'Publish the branch first to pull commits'
    ),
    nothingNewToPull: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingNewToPull',
      'Nothing new to pull — remote only has older copies of local commits'
    ),
    nothingToPull: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPull',
      'Nothing to pull'
    ),
    checkOutBranchToFastForward: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToFastForward',
      'Check out a branch before fast-forwarding'
    ),
    publishBranchFirstToFastForward: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToFastForward',
      'Publish the branch first to fast-forward'
    ),
    nothingNewToFastForward: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingNewToFastForward',
      'Nothing new to fast-forward — remote only has older copies of local commits'
    ),
    nothingToFastForward: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToFastForward',
      'Nothing to fast-forward'
    ),
    tryFastForwardPull: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleTryFastForwardPull',
      'Try a fast-forward pull; git may reject local commits'
    ),
    checkOutBranchToSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirst',
      'Publish the branch first to sync commits'
    ),
    useForcePushToSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUseForcePushToSync',
      'Use Force Push — remote only has older copies of local commits'
    ),
    branchUpToDate: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleBranchUpToDate',
      'Branch is up to date'
    ),
    rebaseFromNamedBase: (baseRef) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromNamedBase',
        'Rebase from {{baseRef}}',
        { baseRef }
      ),
    rebaseFromBase: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromBase',
      'Rebase from Base'
    ),
    rebaseChooseRemoteBase: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseChooseRemoteBase',
      'Choose a remote base branch to rebase from'
    ),
    rebaseDirtyHint: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseDirtyHint',
      'Try rebasing; git may require committing or stashing local changes first'
    ),
    rebaseWithLatestFrom: (baseRef) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseWithLatestFrom',
        'Rebase current branch with latest commits from {{baseRef}}',
        { baseRef }
      ),
    fetch: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7',
      'Fetch'
    ),
    fetchTitle: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.04d709801d',
      'Fetch from remote without merging'
    ),
    linkedReviewBranchExists: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewBranchExists',
      'Linked review branch already exists'
    ),
    checkOutBranchToPublish: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPublish',
      'Check out a branch before publishing commits'
    ),
    branchAlreadyPublished: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleBranchAlreadyPublished',
      'Branch is already published'
    ),
    publishToOrigin: translate(
      'auto.components.right.sidebar.source.control.primary.action.1884cf34af',
      'Publish this branch to origin'
    ),
    pushCount: localizedPushCount,
    pullCount: localizedPullCount,
    fastForwardCount: localizedFastForwardCount,
    syncCounts: localizedSyncCounts,
    forcePushWithLease: localizedForcePushWithLease,
    manualForcePush: localizedManualForcePush,
    unpublishedForcePush: localizedUnpublishedForcePush
  }
}
