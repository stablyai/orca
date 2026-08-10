import { translate } from '@/i18n/i18n'

export function commitStagedChangesTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitStagedChanges',
    'Commit staged changes'
  )
}

export function checkingBranchStatusTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkingBranchStatus',
    'Checking branch status…'
  )
}

export function checkingPrStatusTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkingPrStatus',
    'Checking PR status…'
  )
}

export function prAlreadyMergedTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.prAlreadyMerged',
    'PR is already merged'
  )
}

export function checkoutBeforePushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforePush',
    'Check out a branch before pushing commits'
  )
}

export function checkoutBeforeForcePushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforeForcePush',
    'Check out a branch before force pushing commits'
  )
}

export function checkoutBeforePullTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforePull',
    'Check out a branch before pulling commits'
  )
}

export function checkoutBeforeFastForwardTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforeFastForward',
    'Check out a branch before fast-forwarding'
  )
}

export function checkoutBeforeSyncTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforeSync',
    'Check out a branch before syncing commits'
  )
}

export function checkoutBeforePublishTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBeforePublish',
    'Check out a branch before publishing commits'
  )
}

export function linkedReviewTargetUnavailableTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.linkedReviewTargetUnavailable',
    'Linked review branch target is unavailable'
  )
}

export function publishFirstToPushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.publishFirstToPush',
    'Publish the branch first to push commits'
  )
}

export function publishFirstToPullTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.publishFirstToPull',
    'Publish the branch first to pull commits'
  )
}

export function publishFirstToFastForwardTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.publishFirstToFastForward',
    'Publish the branch first to fast-forward'
  )
}

export function publishFirstToSyncTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.publishFirstToSync',
    'Publish the branch first to sync commits'
  )
}

export function commitAndForcePushWithLeaseTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitAndForcePushWithLease',
    'Commit staged changes and force push with lease'
  )
}

export function commitAndTryPushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitAndTryPush',
    'Commit staged changes and try to push'
  )
}

export function commitAndPushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitAndPush',
    'Commit staged changes and push'
  )
}

export function preferCommitAndForcePushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.useCommitAndForcePush',
    'Use Commit & Force Push — remote only has older copies of local commits'
  )
}

export function commitThenPullPushTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitThenPullPush',
    'Commit, then pull and push'
  )
}

export function pushSetUpstreamTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.pushSetUpstream',
    'Push this branch and set an upstream if needed'
  )
}

export function pushLinkedReviewUpdatesTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.pushLinkedReviewUpdates',
    'Push updates to the linked review branch'
  )
}

export function tryRegularPushMayForceTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.tryRegularPushMayForce',
    'Try a regular push; git may require force push'
  )
}

export function pushMayRequireSyncTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.pushMayRequireSync',
    'Push local commits; git may require syncing first'
  )
}

export function nothingToPushTitle(upstreamName?: string): string {
  return upstreamName
    ? translate(
        'auto.components.rightSidebar.sourceControl.nothingToPushTo',
        'Nothing to push to {{upstream}}',
        { upstream: upstreamName }
      )
    : translate('auto.components.rightSidebar.sourceControl.nothingToPush', 'Nothing to push')
}

export function nothingToForcePushTitle(upstreamName?: string): string {
  return upstreamName
    ? translate(
        'auto.components.rightSidebar.sourceControl.nothingToForcePushTo',
        'Nothing to force push to {{upstream}}',
        { upstream: upstreamName }
      )
    : translate(
        'auto.components.rightSidebar.sourceControl.nothingToForcePush',
        'Nothing to force push'
      )
}

export function nothingNewToPullOlderRemoteTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.nothingNewToPullOlderRemote',
    'Nothing new to pull — remote only has older copies of local commits'
  )
}

export function nothingNewToFastForwardOlderRemoteTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.nothingNewToFastForwardOlderRemote',
    'Nothing new to fast-forward — remote only has older copies of local commits'
  )
}

export function tryFastForwardMayRejectTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.tryFastForwardMayReject',
    'Try a fast-forward pull; git may reject local commits'
  )
}

export function preferForcePushOlderRemoteTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.useForcePushOlderRemote',
    'Use Force Push — remote only has older copies of local commits'
  )
}

export function branchUpToDateTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.branchUpToDate',
    'Branch is up to date'
  )
}

export function chooseRemoteBaseToRebaseTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.chooseRemoteBaseToRebase',
    'Choose a remote base branch to rebase from'
  )
}

export function rebaseCurrentFromBaseTitle(baseLabel: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.rebaseCurrentFromBase',
    'Rebase current branch with latest commits from {{base}}',
    { base: baseLabel }
  )
}
