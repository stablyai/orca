/* eslint-disable max-lines -- Why: this dropdown state machine keeps every action row in one table so priority and disabled-state regressions stay visible in tests. */
// Why: split from source-control-primary-action because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import type { PrimaryActionInputs } from './source-control-primary-action'
import { canSubmitCommit, resolveCommitDisabledReason } from './source-control-commit-eligibility'
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

function describePushCount(ahead: number): string {
  return `Push ${ahead} commit${ahead === 1 ? '' : 's'}`
}

function describePullCount(behind: number): string {
  return `Pull ${behind} commit${behind === 1 ? '' : 's'}`
}

function describeFastForwardCount(behind: number): string {
  return `Fast-forward ${behind} commit${behind === 1 ? '' : 's'}`
}

function describeSyncCounts(ahead: number, behind: number): string {
  return `Pull ${behind}, push ${ahead}`
}

function formatCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}

function formatSyncLabel(base: string, ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) {
    return base
  }
  return `${base} (↓${behind} ↑${ahead})`
}

function formatForcePushTitle(branchCommitsAhead: number | undefined, upstreamName?: string) {
  const countText =
    branchCommitsAhead && branchCommitsAhead > 0
      ? `${branchCommitsAhead} branch commit${branchCommitsAhead === 1 ? '' : 's'}`
      : 'this branch'
  return `Remote only has older copies of local commits. Force push ${countText} with lease to update ${upstreamName ?? 'the remote branch'}.`
}

function formatManualForcePushTitle(ahead: number, behind: number, upstreamName?: string): string {
  const commitText = ahead === 1 ? '1 local commit' : `${ahead} local commits`
  if (behind > 0) {
    return `Force push ${commitText} with lease to update ${upstreamName ?? 'the remote branch'} and replace remote-only commits.`
  }
  return `Force push ${commitText} with lease to update ${upstreamName ?? 'the remote branch'}.`
}

function formatUnpublishedForcePushTitle(branchCommitsAhead: number | undefined): string {
  const countText =
    branchCommitsAhead && branchCommitsAhead > 0
      ? `${branchCommitsAhead} branch commit${branchCommitsAhead === 1 ? '' : 's'}`
      : 'this branch'
  return `Force push ${countText} with lease and set an upstream if needed.`
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
 * Resolve the chevron dropdown items. Every item is always rendered so the
 * menu shape stays stable across states; inapplicable rows are disabled
 * with a tooltip reason rather than hidden.
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
  // Why: mirror the primary-action guard. When upstreamStatus is undefined,
  // fetchUpstreamStatus hasn't resolved for this worktree yet. Collapsing that
  // to hasUpstream=false would re-enable Publish Branch on an already-tracked
  // branch during the post-worktree-switch transient window, and a click there
  // would re-run `git push -u` and clobber the real upstream. Every
  // upstream-dependent row disables itself while loading so the primary
  // button's stable-frame guarantee extends to the dropdown. Explicit
  // Push/Force Push are the exception for loading/unpublished branches: the
  // git command resolves its target itself. Linked-review rows without a
  // usable push target still block — otherwise we would push an unrelated
  // configured upstream while the menu claimed first-publish semantics.
  const upstreamLoading = upstreamStatus === undefined
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const hasOpenHostedReview = prState === 'open' || prState === 'draft'
  const canPushUntrackedHostedReview =
    !hasUpstream &&
    hasOpenHostedReview &&
    hasCurrentBranch &&
    branchCommitsAhead !== 0 &&
    canPushLinkedReviewWithoutUpstream
  // Why: only the missing review head is a hard block. branchCommitsAhead === 0
  // still means the target is known — primary Push stays available, and
  // explicit Push must match that rather than claiming "target unavailable".
  const pushBlockedByOpenHostedReviewTarget =
    !hasUpstream && hasOpenHostedReview && !canPushLinkedReviewWithoutUpstream
  const publishBlockedByMergedPR = !hasUpstream && prState === 'merged'
  const publishBlockedByPRLoading = !hasUpstream && !!isPRStateLoading
  const publishBlockedByOpenHostedReview = !hasUpstream && hasOpenHostedReview
  const publishBlockedByDetachedHead = !hasUpstream && !hasCurrentBranch
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0
  const shouldForcePushWithLease = shouldForcePushWithLeaseForUpstream(upstreamStatus)
  // Why: force-push counts prefer branch-compare when upstream ahead is missing
  // or misleading — unpublished/loading branches report ahead=0, and
  // patch-equivalent rewrites inflate ahead far above real branch commits.
  // On a normal tracked branch, upstream ahead is the correct force-push size.
  const pushLabelCount =
    branchCommitsAhead !== undefined &&
    branchCommitsAhead > 0 &&
    (shouldForcePushWithLease || !hasUpstream)
      ? branchCommitsAhead
      : ahead
  const forcePushTitle = formatForcePushTitle(branchCommitsAhead, upstreamStatus?.upstreamName)
  const createReviewCopy = reviewCopy(hostedReviewCreation?.provider)

  // Why: any in-flight commit or remote operation should lock the whole menu.
  // A running push shouldn't let a second pull/sync click queue up behind it
  // on a stale status snapshot.
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
  const commitItem: DropdownItem = {
    kind: 'commit',
    label: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd',
      'Commit'
    ),
    title: commitDisabledReason ?? 'Commit staged changes',
    disabled: !canCommit
  }

  // Why: compound commit labels omit counts because the commit itself changes
  // ahead/behind — surfacing pre-commit numbers would be misleading (e.g.
  // "Commit & Push (2)" would still read "2" after the commit lands at 3).
  // On an unpublished branch, Commit & Push is unavailable: the user must
  // Publish Branch first (offered via the primary action), after which
  // Commit & Push becomes enabled. Tooltips mirror pushItem/syncItem copy
  // so the "publish first" instruction is consistent across the menu.
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
  const commitPushItem: DropdownItem = {
    kind: 'commit_push',
    label: shouldForcePushWithLease ? 'Commit & Force Push' : 'Commit & Push',
    title: commitPushTitle,
    // Why: match explicit Push — only an open linked review with a known head
    // can commit+push without a git upstream. Missing heads still block; plain
    // unpublished branches still need Publish first.
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
      // Why: mirror pushItem/syncItem — direct the user to Publish Branch
      // (the primary action on an unpublished branch) rather than naming a
      // nonexistent compound action.
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
    // Why: keep Push available without an upstream (git resolves --set-upstream
    // itself) and even when force-with-lease is recommended — regular Push must
    // stay a non-force path. Only block detached HEAD and linked reviews whose
    // push target is still unknown (otherwise we would push an unrelated upstream).
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const forcePushItem: DropdownItem = {
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
    // Why: same target-safety gate as Push — force-with-lease to a wrong or
    // unresolved review head is worse than blocking the row until the target
    // is known. Explicit Force Push stays available without an upstream.
    disabled: globalBusy || publishBlockedByDetachedHead || pushBlockedByOpenHostedReviewTarget
  }

  const pullItem: DropdownItem = {
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

  const fastForwardItem: DropdownItem = {
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

  const syncItem: DropdownItem = {
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
  const rebaseItem: DropdownItem = {
    kind: 'rebase_base',
    label: rebaseBaseLabel ? `Rebase from ${rebaseBaseLabel}` : 'Rebase from Base',
    title: (() => {
      if (!rebaseBaseLabel || !hasRemoteBaseRef) {
        return 'Choose a remote base branch to rebase from'
      }
      if (hasDirtyLocalChanges) {
        return 'Try rebasing; git may require committing or stashing local changes first'
      }
      return `Rebase current branch with latest commits from ${rebaseBaseLabel}`
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

  const createBlockedHint = (() => {
    switch (hostedReviewCreation?.blockedReason) {
      case 'dirty':
        return 'Commit changes first'
      case 'detached_head':
        return 'Check out a branch first'
      case 'default_branch':
        return 'Switch to a feature branch'
      case 'no_upstream':
        return 'Publish Branch'
      case 'needs_push':
        return 'Push first'
      case 'needs_sync':
        return shouldForcePushWithLease ? 'Force Push first' : 'Sync first'
      case 'auth_required':
        return `${createReviewCopy.authInstruction} in this environment`
      case 'unsupported_provider':
        return 'Unsupported provider'
      case 'existing_review':
        return `A ${createReviewCopy.reviewLabel} already exists`
      case 'fork_head_unsupported':
        return 'Fork head unsupported'
      case null:
      case undefined:
        return upstreamLoading ? 'Checking branch status…' : 'Branch is not ready'
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
      ? `Create a ${createReviewCopy.reviewLabel} for this branch`
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
        ? `Force push with lease before creating a ${createReviewCopy.reviewLabel}`
        : `Push local commits before creating a ${createReviewCopy.reviewLabel}`
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
        title: globalBusy ? 'Operation in progress…' : `Abort the ${conflictOperation} in progress`,
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
