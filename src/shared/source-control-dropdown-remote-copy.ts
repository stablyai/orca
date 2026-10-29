import {
  describeFastForwardCount,
  describePullCount,
  describePushCount,
  describeSyncCounts,
  formatForcePushTitle,
  formatManualForcePushTitle,
  formatUnpublishedForcePushTitle
} from './source-control-dropdown-labels'

// Desktop localizes these strings; other clients pass their own copy.
export type RemoteDropdownCopy = {
  push: string
  forcePush: string
  pull: string
  fastForward: string
  sync: string
  publishBranch: string
  publishPrStatus: string
  publishLinkedReview: string
  publishNoBranch: string
  checkingBranchStatus: string
  checkingPrStatus: string
  prAlreadyMerged: string
  linkedReviewTargetUnavailable: string
  checkOutBranchToPush: string
  pushAndSetUpstream: string
  pushToLinkedReview: string
  tryRegularPush: string
  pushMayNeedSync: string
  nothingToPushTo: (upstreamName: string) => string
  nothingToPush: string
  checkOutBranchToForcePush: string
  nothingToForcePushTo: (upstreamName: string) => string
  nothingToForcePush: string
  checkOutBranchToPull: string
  publishBranchFirstToPull: string
  nothingNewToPull: string
  nothingToPull: string
  checkOutBranchToFastForward: string
  publishBranchFirstToFastForward: string
  nothingNewToFastForward: string
  nothingToFastForward: string
  tryFastForwardPull: string
  checkOutBranchToSync: string
  publishBranchFirstToSync: string
  useForcePushToSync: string
  branchUpToDate: string
  rebaseFromNamedBase: (baseRef: string) => string
  rebaseFromBase: string
  rebaseChooseRemoteBase: string
  rebaseDirtyHint: string
  rebaseWithLatestFrom: (baseRef: string) => string
  fetch: string
  fetchTitle: string
  linkedReviewBranchExists: string
  checkOutBranchToPublish: string
  branchAlreadyPublished: string
  publishToOrigin: string
  pushCount: (ahead: number) => string
  pullCount: (behind: number) => string
  fastForwardCount: (behind: number) => string
  syncCounts: (ahead: number, behind: number) => string
  forcePushWithLease: (branchCommitsAhead: number | undefined, upstreamName?: string) => string
  manualForcePush: (ahead: number, behind: number, upstreamName?: string) => string
  unpublishedForcePush: (branchCommitsAhead: number | undefined) => string
}

export const ENGLISH_REMOTE_DROPDOWN_COPY: RemoteDropdownCopy = {
  push: 'Push',
  forcePush: 'Force Push',
  pull: 'Pull',
  fastForward: 'Fast-forward',
  sync: 'Sync',
  publishBranch: 'Publish Branch',
  publishPrStatus: 'PR Status',
  publishLinkedReview: 'Linked Review',
  publishNoBranch: 'No Branch',
  checkingBranchStatus: 'Checking branch status…',
  checkingPrStatus: 'Checking PR status…',
  prAlreadyMerged: 'PR is already merged',
  linkedReviewTargetUnavailable: 'Linked review branch target is unavailable',
  checkOutBranchToPush: 'Check out a branch before pushing commits',
  pushAndSetUpstream: 'Push this branch and set an upstream if needed',
  pushToLinkedReview: 'Push updates to the linked review branch',
  tryRegularPush: 'Try a regular push; git may require force push',
  pushMayNeedSync: 'Push local commits; git may require syncing first',
  nothingToPushTo: (upstreamName) => `Nothing to push to ${upstreamName}`,
  nothingToPush: 'Nothing to push',
  checkOutBranchToForcePush: 'Check out a branch before force pushing commits',
  nothingToForcePushTo: (upstreamName) => `Nothing to force push to ${upstreamName}`,
  nothingToForcePush: 'Nothing to force push',
  checkOutBranchToPull: 'Check out a branch before pulling commits',
  publishBranchFirstToPull: 'Publish the branch first to pull commits',
  nothingNewToPull: 'Nothing new to pull — remote only has older copies of local commits',
  nothingToPull: 'Nothing to pull',
  checkOutBranchToFastForward: 'Check out a branch before fast-forwarding',
  publishBranchFirstToFastForward: 'Publish the branch first to fast-forward',
  nothingNewToFastForward:
    'Nothing new to fast-forward — remote only has older copies of local commits',
  nothingToFastForward: 'Nothing to fast-forward',
  tryFastForwardPull: 'Try a fast-forward pull; git may reject local commits',
  checkOutBranchToSync: 'Check out a branch before syncing commits',
  publishBranchFirstToSync: 'Publish the branch first to sync commits',
  useForcePushToSync: 'Use Force Push — remote only has older copies of local commits',
  branchUpToDate: 'Branch is up to date',
  rebaseFromNamedBase: (baseRef) => `Rebase from ${baseRef}`,
  rebaseFromBase: 'Rebase from Base',
  rebaseChooseRemoteBase: 'Choose a remote base branch to rebase from',
  rebaseDirtyHint: 'Try rebasing; git may require committing or stashing local changes first',
  rebaseWithLatestFrom: (baseRef) => `Rebase current branch with latest commits from ${baseRef}`,
  fetch: 'Fetch',
  fetchTitle: 'Fetch from remote without merging',
  linkedReviewBranchExists: 'Linked review branch already exists',
  checkOutBranchToPublish: 'Check out a branch before publishing commits',
  branchAlreadyPublished: 'Branch is already published',
  publishToOrigin: 'Publish this branch to origin',
  pushCount: describePushCount,
  pullCount: describePullCount,
  fastForwardCount: describeFastForwardCount,
  syncCounts: describeSyncCounts,
  forcePushWithLease: formatForcePushTitle,
  manualForcePush: formatManualForcePushTitle,
  unpublishedForcePush: formatUnpublishedForcePushTitle
}
