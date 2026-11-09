import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { RemoteDropdownCopy } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-remote-copy'
import {
  localizedFastForwardCount,
  localizedForcePushWithLease,
  localizedManualForcePush,
  localizedPullCount,
  localizedPushCount,
  localizedSyncCounts,
  localizedUnpublishedForcePush
} from './source-control-count-localized-copy'

export function localizedRemoteCopy(t: Translate = translate): RemoteDropdownCopy {
  return {
    push: t('auto.components.right.sidebar.source.control.primary.action.95550cff15', 'Push'),
    forcePush: t(
      'auto.components.right.sidebar.source.control.primary.action.390abeab93',
      'Force Push'
    ),
    pull: t('auto.components.right.sidebar.source.control.primary.action.d64292a938', 'Pull'),
    fastForward: t(
      'auto.components.right.sidebar.source.control.dropdown.items.fastForward',
      'Fast-forward'
    ),
    sync: t('auto.components.right.sidebar.source.control.primary.action.795f1509c5', 'Sync'),
    publishBranch: t(
      'auto.components.right.sidebar.source.control.primary.action.7b4d02e6b8',
      'Publish Branch'
    ),
    publishPrStatus: t(
      'auto.components.right.sidebar.source.control.dropdown.items.publishPrStatus',
      'PR Status'
    ),
    publishLinkedReview: t(
      'auto.components.right.sidebar.source.control.dropdown.items.publishLinkedReview',
      'Linked Review'
    ),
    publishNoBranch: t(
      'auto.components.right.sidebar.source.control.dropdown.items.publishNoBranch',
      'No Branch'
    ),
    checkingBranchStatus: t(
      'auto.components.right.sidebar.source.control.dropdown.items.checkingBranchStatus',
      'Checking branch status…'
    ),
    checkingPrStatus: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckingPrStatus',
      'Checking PR status…'
    ),
    prAlreadyMerged: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePrAlreadyMerged',
      'PR is already merged'
    ),
    linkedReviewTargetUnavailable: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    checkOutBranchToPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    pushAndSetUpstream: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePushAndSetUpstream',
      'Push this branch and set an upstream if needed'
    ),
    pushToLinkedReview: t(
      'auto.components.right.sidebar.source.control.primary.action.1d47e850cf',
      'Push updates to the linked review branch'
    ),
    tryRegularPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleTryRegularPush',
      'Try a regular push; git may require force push'
    ),
    pushMayNeedSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePushMayNeedSync',
      'Push local commits; git may require syncing first'
    ),
    nothingToPushTo: (upstreamName) =>
      t(
        'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPushTo',
        'Nothing to push to {{upstreamName}}',
        { upstreamName }
      ),
    nothingToPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPush',
      'Nothing to push'
    ),
    checkOutBranchToForcePush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToForcePush',
      'Check out a branch before force pushing commits'
    ),
    nothingToForcePushTo: (upstreamName) =>
      t(
        'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToForcePushTo',
        'Nothing to force push to {{upstreamName}}',
        { upstreamName }
      ),
    nothingToForcePush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToForcePush',
      'Nothing to force push'
    ),
    checkOutBranchToPull: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPull',
      'Check out a branch before pulling commits'
    ),
    publishBranchFirstToPull: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToPull',
      'Publish the branch first to pull commits'
    ),
    nothingNewToPull: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingNewToPull',
      'Nothing new to pull — remote only has older copies of local commits'
    ),
    nothingToPull: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToPull',
      'Nothing to pull'
    ),
    checkOutBranchToFastForward: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToFastForward',
      'Check out a branch before fast-forwarding'
    ),
    publishBranchFirstToFastForward: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToFastForward',
      'Publish the branch first to fast-forward'
    ),
    nothingNewToFastForward: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingNewToFastForward',
      'Nothing new to fast-forward — remote only has older copies of local commits'
    ),
    nothingToFastForward: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleNothingToFastForward',
      'Nothing to fast-forward'
    ),
    tryFastForwardPull: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleTryFastForwardPull',
      'Try a fast-forward pull; git may reject local commits'
    ),
    checkOutBranchToSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirst',
      'Publish the branch first to sync commits'
    ),
    useForcePushToSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUseForcePushToSync',
      'Use Force Push — remote only has older copies of local commits'
    ),
    branchUpToDate: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleBranchUpToDate',
      'Branch is up to date'
    ),
    rebaseFromNamedBase: (baseRef) =>
      t(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromNamedBase',
        'Rebase from {{baseRef}}',
        { baseRef }
      ),
    rebaseFromBase: t(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromBase',
      'Rebase from Base'
    ),
    rebaseChooseRemoteBase: t(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseChooseRemoteBase',
      'Choose a remote base branch to rebase from'
    ),
    rebaseDirtyHint: t(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseDirtyHint',
      'Try rebasing; git may require committing or stashing local changes first'
    ),
    rebaseWithLatestFrom: (baseRef) =>
      t(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseWithLatestFrom',
        'Rebase current branch with latest commits from {{baseRef}}',
        { baseRef }
      ),
    fetch: t('auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7', 'Fetch'),
    fetchTitle: t(
      'auto.components.right.sidebar.source.control.dropdown.items.04d709801d',
      'Fetch from remote without merging'
    ),
    linkedReviewBranchExists: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewBranchExists',
      'Linked review branch already exists'
    ),
    checkOutBranchToPublish: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPublish',
      'Check out a branch before publishing commits'
    ),
    branchAlreadyPublished: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleBranchAlreadyPublished',
      'Branch is already published'
    ),
    publishToOrigin: t(
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
