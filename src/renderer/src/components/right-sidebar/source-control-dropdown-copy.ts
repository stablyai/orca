import { translate } from '@/i18n/i18n'
import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'

/** Tooltip for Commit & Sync: why it is disabled, or what it will do. */
export function commitSyncTitle(state: {
  upstreamLoading: boolean
  publishBlockedByPRLoading: boolean
  publishBlockedByMergedPR: boolean
  publishBlockedByDetachedHead: boolean
  hasUpstream: boolean
  shouldForcePushWithLease: boolean
  commitDisabledReason: string | null
}): string {
  if (state.upstreamLoading) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckingBranchStatus',
      'Checking branch status…'
    )
  }
  if (state.publishBlockedByPRLoading) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckingPrStatus',
      'Checking PR status…'
    )
  }
  if (state.publishBlockedByMergedPR) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePrAlreadyMerged',
      'PR is already merged'
    )
  }
  if (state.publishBlockedByDetachedHead) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToSync',
      'Check out a branch before syncing commits'
    )
  }
  if (!state.hasUpstream) {
    // Why: direct the user to Publish Branch (the primary action) rather than naming a nonexistent compound action.
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirst',
      'Publish the branch first to sync commits'
    )
  }
  if (state.shouldForcePushWithLease) {
    return (
      state.commitDisabledReason ??
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleUseForcePush',
        'Use Commit & Force Push — remote only has older copies of local commits'
      )
    )
  }
  return (
    state.commitDisabledReason ??
    translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitThenPullPush',
      'Commit, then pull and push'
    )
  )
}

/** Label and tooltip for the rebase entry, which names its base branch. */
export function rebaseItemCopy(state: {
  rebaseBaseLabel: string | null
  hasRemoteBaseRef: boolean
  hasDirtyLocalChanges: boolean
}): { label: string; title: string } {
  const label = state.rebaseBaseLabel
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromNamedBase',
        'Rebase from {{value0}}',
        {
          value0: state.rebaseBaseLabel
        }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromBase',
        'Rebase from Base'
      )

  if (!state.rebaseBaseLabel || !state.hasRemoteBaseRef) {
    return {
      label,
      title: translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseChooseRemoteBase',
        'Choose a remote base branch to rebase from'
      )
    }
  }
  if (state.hasDirtyLocalChanges) {
    return {
      label,
      title: translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseDirtyHint',
        'Try rebasing; git may require committing or stashing local changes first'
      )
    }
  }
  return {
    label,
    title: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseWithLatestFrom',
      'Rebase current branch with latest commits from {{value0}}',
      { value0: state.rebaseBaseLabel }
    )
  }
}

/** Why creating a hosted review is blocked, phrased as the next step to take. */
export function createBlockedHint(state: {
  blockedReason: HostedReviewCreationBlockedReason | undefined
  shouldForcePushWithLease: boolean
  upstreamLoading: boolean
  authInstruction: string
  reviewLabel: string
}): string {
  switch (state.blockedReason) {
    case 'dirty':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedCommitFirst',
        'Commit changes first'
      )
    case 'detached_head':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedCheckOutBranchFirst',
        'Check out a branch first'
      )
    case 'default_branch':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedSwitchToFeatureBranch',
        'Switch to a feature branch'
      )
    case 'no_upstream':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedPublishBranch',
        'Publish Branch'
      )
    case 'needs_push':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedPushFirst',
        'Push first'
      )
    case 'needs_sync':
      return state.shouldForcePushWithLease
        ? translate(
            'auto.components.right.sidebar.source.control.dropdown.items.blockedForcePushFirst',
            'Force Push first'
          )
        : translate(
            'auto.components.right.sidebar.source.control.dropdown.items.blockedSyncFirst',
            'Sync first'
          )
    case 'auth_required':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedAuthRequired',
        '{{value0}} in this environment',
        {
          value0: state.authInstruction
        }
      )
    case 'unsupported_provider':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedUnsupportedProvider',
        'Unsupported provider'
      )
    case 'existing_review':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedExistingReview',
        'A {{value0}} already exists',
        {
          value0: state.reviewLabel
        }
      )
    case 'fork_head_unsupported':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedForkHeadUnsupported',
        'Fork head unsupported'
      )
    case 'base_not_on_remote':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.blockedBaseNotOnRemote',
        'Base branch is not on the remote'
      )
    case null:
    case undefined:
      return state.upstreamLoading
        ? translate(
            'auto.components.right.sidebar.source.control.dropdown.items.titleCheckingBranchStatus',
            'Checking branch status…'
          )
        : translate(
            'auto.components.right.sidebar.source.control.dropdown.items.blockedBranchNotReady',
            'Branch is not ready'
          )
  }
}
