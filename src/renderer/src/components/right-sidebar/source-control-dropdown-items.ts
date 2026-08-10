/* eslint-disable max-lines -- Why: this dropdown state machine keeps every action row in one table so priority and disabled-state regressions stay visible in tests. */
// Why: split from source-control-primary-action — primary and dropdown are independent derivations with different priority ladders.

import type { PrimaryActionInputs } from './source-control-primary-action'
import {
  canSubmitCommit,
  localizeCommitDisabledReason,
  resolveCommitDisabledReason
} from './source-control-commit-eligibility'
import type { GitConflictOperation } from '../../../../shared/types'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import { supportsHostedReviewCreation } from '../../../../shared/hosted-review-creation-providers'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  canClickBlockedCreateReviewReason,
  resolveHostedReviewAuthInstruction
} from './source-control-create-review-blocked-action'
import {
  branchAlreadyPublishedTitle,
  describeFastForwardCount,
  describeForcePushWithLease,
  describePullCount,
  describePushCount,
  describeSyncCounts,
  formatManualForcePushTitle,
  formatUnpublishedForcePushTitle,
  nothingToFastForwardTitle,
  nothingToPullTitle,
  switchToFeatureBranchHint,
  tryRebasingDirtyTitle
} from './source-control-primary-action-titles'
import {
  abortConflictInProgressTitle,
  authRequiredInEnvironmentTitle,
  baseBranchNotOnRemoteTitle,
  branchNotReadyTitle,
  checkoutBranchFirstTitle,
  commitChangesFirstTitle,
  createReviewForBranchTitle,
  forcePushBeforeCreateReviewTitle,
  forcePushFirstTitle,
  forkHeadUnsupportedTitle,
  linkedReviewBranchExistsTitle,
  operationInProgressTitle,
  publishBranchToOriginTitle,
  pushBeforeCreateReviewTitle,
  pushFirstTitle,
  reviewAlreadyExistsTitle,
  syncFirstTitle,
  unsupportedProviderTitle
} from './source-control-dropdown-review-status-titles'
import {
  branchUpToDateTitle,
  checkoutBeforeFastForwardTitle,
  checkoutBeforeForcePushTitle,
  checkoutBeforePublishTitle,
  checkoutBeforePullTitle,
  checkoutBeforePushTitle,
  checkoutBeforeSyncTitle,
  checkingBranchStatusTitle,
  checkingPrStatusTitle,
  chooseRemoteBaseToRebaseTitle,
  commitAndForcePushWithLeaseTitle,
  commitAndPushTitle,
  commitAndTryPushTitle,
  commitStagedChangesTitle,
  commitThenPullPushTitle,
  linkedReviewTargetUnavailableTitle,
  nothingNewToFastForwardOlderRemoteTitle,
  nothingNewToPullOlderRemoteTitle,
  nothingToForcePushTitle,
  nothingToPushTitle,
  prAlreadyMergedTitle,
  preferCommitAndForcePushTitle,
  preferForcePushOlderRemoteTitle,
  publishFirstToFastForwardTitle,
  publishFirstToPullTitle,
  publishFirstToPushTitle,
  publishFirstToSyncTitle,
  pushLinkedReviewUpdatesTitle,
  pushMayRequireSyncTitle,
  pushSetUpstreamTitle,
  rebaseCurrentFromBaseTitle,
  tryFastForwardMayRejectTitle,
  tryRegularPushMayForceTitle
} from './source-control-dropdown-status-titles'

export type DropdownActionInputs = PrimaryActionInputs & {
  conflictOperation?: GitConflictOperation
  isPullRequestOperationActive?: boolean
  rebaseBaseRef?: string | null
}

export type DropdownActionKind =
  | 'commit'
  | 'commit_push'
  | 'commit_sync'
  | 'abort_merge'
  | 'abort_rebase'
  | 'create_pr'
  | 'push_create_pr'
  | 'push'
  | 'force_push'
  | 'pull'
  | 'fast_forward'
  | 'sync'
  | 'rebase_base'
  | 'fetch'
  | 'publish'

export type DropdownItem = {
  kind: DropdownActionKind
  label: string
  title: string
  disabled: boolean
  hint?: string
  variant?: 'default' | 'destructive'
}

export type DropdownSeparator = { kind: 'separator' }

export type DropdownEntry = DropdownItem | DropdownSeparator

function formatCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}

function formatSyncLabel(base: string, ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) {
    return base
  }
  return `${base} (↓${behind} ↑${ahead})`
}

function formatRebaseBaseRef(baseRef: string): string {
  return baseRef.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
}

function reviewCopy(
  provider: NonNullable<PrimaryActionInputs['hostedReviewCreation']>['provider'] | undefined
): ReturnType<typeof localizedHostedReviewCopy> & {
  authInstruction: string
} {
  return {
    ...localizedHostedReviewCopy(resolveSupportedHostedReviewCopyProvider(provider)),
    authInstruction: resolveHostedReviewAuthInstruction(provider ?? 'github')
  }
}

/**
 * Resolve the chevron dropdown items. Every row is always rendered — disabled with a
 * tooltip reason rather than hidden — so the menu shape stays stable across states.
 */
export function resolveDropdownItems(inputs: DropdownActionInputs): DropdownEntry[] {
  const {
    stagedCount,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    prState,
    isPRStateLoading,
    hostedReviewCreation,
    conflictOperation = 'unknown',
    branchCommitsAhead,
    hasCurrentBranch = true,
    canPushLinkedReviewWithoutUpstream = false,
    rebaseBaseRef,
    isPullRequestOperationActive = false
  } = inputs

  const hasStaged = stagedCount > 0
  const hasDirtyLocalChanges = hasStaged || inputs.hasUnstagedChanges
  // Why: undefined upstreamStatus means loading (transient after a worktree switch), not unpublished — treating it as hasUpstream=false would re-enable Publish Branch and clobber the real upstream.
  const upstreamLoading = upstreamStatus === undefined
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const hasOpenHostedReview = prState === 'open' || prState === 'draft'
  const canPushUntrackedHostedReview =
    !hasUpstream &&
    hasOpenHostedReview &&
    hasCurrentBranch &&
    branchCommitsAhead !== 0 &&
    canPushLinkedReviewWithoutUpstream
  // Why: only a missing review head hard-blocks; branchCommitsAhead === 0 still means the target is known, so Push stays available.
  const pushBlockedByOpenHostedReviewTarget =
    !hasUpstream && hasOpenHostedReview && !canPushLinkedReviewWithoutUpstream
  const publishBlockedByMergedPR = !hasUpstream && prState === 'merged'
  const publishBlockedByPRLoading = !hasUpstream && !!isPRStateLoading
  const publishBlockedByOpenHostedReview = !hasUpstream && hasOpenHostedReview
  const publishBlockedByDetachedHead = !hasUpstream && !hasCurrentBranch
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0
  const shouldForcePushWithLease = shouldForcePushWithLeaseForUpstream(upstreamStatus)
  // Why: prefer branch-compare for force-push counts — unpublished/loading branches report ahead=0 and patch-equivalent rewrites inflate upstream ahead.
  const pushLabelCount =
    branchCommitsAhead !== undefined &&
    branchCommitsAhead > 0 &&
    (shouldForcePushWithLease || !hasUpstream)
      ? branchCommitsAhead
      : ahead
  const forcePushTitle = describeForcePushWithLease(
    branchCommitsAhead,
    upstreamStatus?.upstreamName
  )
  const createReviewCopy = reviewCopy(hostedReviewCreation?.provider)

  // Why: lock the whole menu during any in-flight op so a second click can't queue on a stale status snapshot.
  const globalBusy = isCommitting || isRemoteOperationActive || isPullRequestOperationActive

  const commitDisabledReason = resolveCommitDisabledReason({
    stagedCount,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts
  })
  const canCommit =
    !globalBusy &&
    canSubmitCommit({
      stagedCount,
      hasPartiallyStagedChanges,
      hasMessage,
      hasUnresolvedConflicts,
      isCommitting,
      isRemoteOperationActive,
      isPullRequestOperationActive
    })
  const commitDisabledTitle = localizeCommitDisabledReason(commitDisabledReason)
  const commitItem: DropdownItem = {
    kind: 'commit',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd',
      'Commit'
    ),
    title: commitDisabledTitle ?? commitStagedChangesTitle(),
    disabled: !canCommit
  }

  // Why: compound commit labels omit counts — the commit itself changes ahead/behind, so pre-commit numbers would mislead.
  const commitPushTitle = upstreamLoading
    ? checkingBranchStatusTitle()
    : publishBlockedByPRLoading
      ? checkingPrStatusTitle()
      : publishBlockedByMergedPR
        ? prAlreadyMergedTitle()
        : publishBlockedByDetachedHead
          ? checkoutBeforePushTitle()
          : pushBlockedByOpenHostedReviewTarget
            ? linkedReviewTargetUnavailableTitle()
            : !hasUpstream && !(hasOpenHostedReview && canPushLinkedReviewWithoutUpstream)
              ? publishFirstToPushTitle()
              : (commitDisabledTitle ??
                (shouldForcePushWithLease
                  ? commitAndForcePushWithLeaseTitle()
                  : behind > 0
                    ? commitAndTryPushTitle()
                    : commitAndPushTitle()))
  const commitPushItem: DropdownItem = {
    kind: 'commit_push',
    label: shouldForcePushWithLease ? 'Commit & Force Push' : 'Commit & Push',
    title: commitPushTitle,
    // Why: match explicit Push — only an open linked review with a known head can commit+push without a git upstream.
    disabled:
      globalBusy ||
      upstreamLoading ||
      (!hasUpstream && !(hasOpenHostedReview && canPushLinkedReviewWithoutUpstream)) ||
      publishBlockedByDetachedHead ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR ||
      commitDisabledReason !== null
  }

  const commitSyncTitle = (() => {
    if (upstreamLoading) {
      return checkingBranchStatusTitle()
    }
    if (publishBlockedByPRLoading) {
      return checkingPrStatusTitle()
    }
    if (publishBlockedByMergedPR) {
      return prAlreadyMergedTitle()
    }
    if (publishBlockedByDetachedHead) {
      return checkoutBeforeSyncTitle()
    }
    if (!hasUpstream) {
      // Why: direct the user to Publish Branch (the primary action) rather than naming a nonexistent compound action.
      return publishFirstToSyncTitle()
    }
    if (shouldForcePushWithLease) {
      return commitDisabledTitle ?? preferCommitAndForcePushTitle()
    }
    return commitDisabledTitle ?? commitThenPullPushTitle()
  })()
  const commitSyncItem: DropdownItem = {
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

  const pushItem: DropdownItem = {
    kind: 'push',
    label: formatCountLabel('Push', ahead),
    title: publishBlockedByDetachedHead
      ? checkoutBeforePushTitle()
      : pushBlockedByOpenHostedReviewTarget
        ? linkedReviewTargetUnavailableTitle()
        : upstreamLoading
          ? pushSetUpstreamTitle()
          : canPushUntrackedHostedReview
            ? pushLinkedReviewUpdatesTitle()
            : !hasUpstream
              ? pushSetUpstreamTitle()
              : shouldForcePushWithLease
                ? tryRegularPushMayForceTitle()
                : behind > 0 && ahead > 0
                  ? pushMayRequireSyncTitle()
                  : ahead === 0
                    ? nothingToPushTitle(upstreamStatus?.upstreamName)
                    : describePushCount(ahead),
    // Why: Push stays available without an upstream (git resolves --set-upstream) and under force-with-lease; only detached HEAD and unknown review targets block.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const forcePushItem: DropdownItem = {
    kind: 'force_push',
    label: formatCountLabel('Force Push', pushLabelCount),
    title: publishBlockedByDetachedHead
      ? checkoutBeforeForcePushTitle()
      : pushBlockedByOpenHostedReviewTarget
        ? linkedReviewTargetUnavailableTitle()
        : upstreamLoading
          ? formatUnpublishedForcePushTitle(branchCommitsAhead)
          : !hasUpstream
            ? formatUnpublishedForcePushTitle(branchCommitsAhead)
            : pushLabelCount === 0
              ? nothingToForcePushTitle(upstreamStatus?.upstreamName)
              : shouldForcePushWithLease
                ? forcePushTitle
                : formatManualForcePushTitle(pushLabelCount, behind, upstreamStatus?.upstreamName),
    // Why: same target-safety gate as Push — force-with-lease to a wrong review head is worse than blocking; stays available without an upstream.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const pullItem: DropdownItem = {
    kind: 'pull',
    label: formatCountLabel('Pull', behind),
    title: upstreamLoading
      ? checkingBranchStatusTitle()
      : publishBlockedByPRLoading
        ? checkingPrStatusTitle()
        : publishBlockedByMergedPR
          ? prAlreadyMergedTitle()
          : publishBlockedByDetachedHead
            ? checkoutBeforePullTitle()
            : !hasUpstream
              ? publishFirstToPullTitle()
              : shouldForcePushWithLease
                ? nothingNewToPullOlderRemoteTitle()
                : behind === 0
                  ? nothingToPullTitle()
                  : describePullCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const fastForwardItem: DropdownItem = {
    kind: 'fast_forward',
    label: formatCountLabel('Fast-forward', behind),
    title: upstreamLoading
      ? checkingBranchStatusTitle()
      : publishBlockedByPRLoading
        ? checkingPrStatusTitle()
        : publishBlockedByMergedPR
          ? prAlreadyMergedTitle()
          : publishBlockedByDetachedHead
            ? checkoutBeforeFastForwardTitle()
            : !hasUpstream
              ? publishFirstToFastForwardTitle()
              : shouldForcePushWithLease
                ? nothingNewToFastForwardOlderRemoteTitle()
                : behind === 0
                  ? nothingToFastForwardTitle()
                  : ahead > 0
                    ? tryFastForwardMayRejectTitle()
                    : describeFastForwardCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || publishBlockedByDetachedHead
  }

  const syncItem: DropdownItem = {
    kind: 'sync',
    label: formatSyncLabel('Sync', ahead, behind),
    title: upstreamLoading
      ? checkingBranchStatusTitle()
      : publishBlockedByPRLoading
        ? checkingPrStatusTitle()
        : publishBlockedByMergedPR
          ? prAlreadyMergedTitle()
          : publishBlockedByDetachedHead
            ? checkoutBeforeSyncTitle()
            : !hasUpstream
              ? publishFirstToSyncTitle()
              : shouldForcePushWithLease
                ? preferForcePushOlderRemoteTitle()
                : ahead === 0 && behind === 0
                  ? branchUpToDateTitle()
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
  const rebaseItem: DropdownItem = {
    kind: 'rebase_base',
    label: rebaseBaseLabel ? `Rebase from ${rebaseBaseLabel}` : 'Rebase from Base',
    title: (() => {
      if (!rebaseBaseLabel || !hasRemoteBaseRef) {
        return chooseRemoteBaseToRebaseTitle()
      }
      if (hasDirtyLocalChanges) {
        return tryRebasingDirtyTitle()
      }
      return rebaseCurrentFromBaseTitle(rebaseBaseLabel)
    })(),
    disabled: globalBusy || !rebaseBaseRef || !hasRemoteBaseRef
  }

  const fetchItem: DropdownItem = {
    kind: 'fetch',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7',
      'Fetch'
    ),
    title: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.04d709801d',
      'Fetch from remote without merging'
    ),
    disabled: globalBusy
  }

  const publishItem: DropdownItem = {
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
      ? checkingBranchStatusTitle()
      : publishBlockedByPRLoading
        ? checkingPrStatusTitle()
        : publishBlockedByMergedPR
          ? prAlreadyMergedTitle()
          : publishBlockedByOpenHostedReview
            ? canPushLinkedReviewWithoutUpstream
              ? linkedReviewBranchExistsTitle()
              : linkedReviewTargetUnavailableTitle()
            : publishBlockedByDetachedHead
              ? checkoutBeforePublishTitle()
              : hasUpstream
                ? branchAlreadyPublishedTitle()
                : publishBranchToOriginTitle(),
    disabled:
      globalBusy ||
      upstreamLoading ||
      hasUpstream ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR ||
      publishBlockedByOpenHostedReview ||
      publishBlockedByDetachedHead
  }

  const createBlockedHint = (() => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return commitChangesFirstTitle()
      case 'detached_head':
        return checkoutBranchFirstTitle()
      case 'default_branch':
        return switchToFeatureBranchHint()
      case 'no_upstream':
        return 'Publish Branch'
      case 'needs_push':
        return pushFirstTitle()
      case 'needs_sync':
        return shouldForcePushWithLease ? forcePushFirstTitle() : syncFirstTitle()
      case 'auth_required':
        return authRequiredInEnvironmentTitle(createReviewCopy.authInstruction)
      case 'unsupported_provider':
        return unsupportedProviderTitle()
      case 'existing_review':
        return reviewAlreadyExistsTitle(createReviewCopy.reviewLabel)
      case 'fork_head_unsupported':
        return forkHeadUnsupportedTitle()
      case 'base_not_on_remote':
        return baseBranchNotOnRemoteTitle()
      case null:
      case undefined:
        return upstreamLoading ? checkingBranchStatusTitle() : branchNotReadyTitle()
    }
  })()

  const createPRItem: DropdownItem = {
    kind: 'create_pr',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.9e779995dd',
      'Create {{value0}}',
      { value0: createReviewCopy.shortLabel }
    ),
    title: hostedReviewCreation?.canCreate
      ? createReviewForBranchTitle(createReviewCopy.reviewLabel)
      : createBlockedHint,
    hint: hostedReviewCreation?.canCreate ? undefined : createBlockedHint,
    disabled:
      globalBusy ||
      !supportsHostedReviewCreation(hostedReviewCreation?.provider) ||
      (!hostedReviewCreation?.canCreate &&
        !canClickBlockedCreateReviewReason(hostedReviewCreation?.blockedReason))
  }

  const canPushAndCreate =
    !globalBusy &&
    !upstreamLoading &&
    supportsHostedReviewCreation(hostedReviewCreation?.provider) &&
    (hostedReviewCreation.blockedReason === 'needs_push' ||
      (hostedReviewCreation.blockedReason === 'needs_sync' && shouldForcePushWithLease))
  const pushCreatePRItem: DropdownItem = {
    kind: 'push_create_pr',
    label: shouldForcePushWithLease
      ? `Force Push before ${createReviewCopy.shortLabel}`
      : `Push before ${createReviewCopy.shortLabel}`,
    title: canPushAndCreate
      ? shouldForcePushWithLease
        ? forcePushBeforeCreateReviewTitle(createReviewCopy.reviewLabel)
        : pushBeforeCreateReviewTitle(createReviewCopy.reviewLabel)
      : createBlockedHint,
    hint: canPushAndCreate ? undefined : createBlockedHint,
    disabled: !canPushAndCreate
  }

  const entries: DropdownEntry[] = [
    commitItem,
    commitPushItem,
    commitSyncItem,
    { kind: 'separator' },
    pushItem,
    forcePushItem,
    createPRItem,
    pushCreatePRItem,
    pullItem,
    fastForwardItem,
    syncItem,
    rebaseItem,
    fetchItem,
    publishItem
  ]
  if (conflictOperation === 'merge' || conflictOperation === 'rebase') {
    const isRebase = conflictOperation === 'rebase'
    const label = isRebase ? 'Abort rebase' : 'Abort merge'
    entries.push(
      { kind: 'separator' },
      {
        kind: isRebase ? 'abort_rebase' : 'abort_merge',
        label,
        title: globalBusy
          ? operationInProgressTitle()
          : abortConflictInProgressTitle(conflictOperation),
        disabled: globalBusy,
        variant: 'destructive'
      }
    )
  }
  if (!isPullRequestOperationActive) {
    return entries
  }
  return entries.map((entry) =>
    entry.kind === 'separator'
      ? entry
      : {
          ...entry,
          title: translate(
            'auto.components.right.sidebar.source.control.dropdown.items.7aad2c0240',
            'Hosted review operation in progress…'
          ),
          disabled: true
        }
  )
}
