/* eslint-disable max-lines -- Why: this dropdown state machine keeps every action row in one table so priority and disabled-state regressions stay visible in tests. */
// Why: split from source-control-primary-action because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import type { PrimaryActionInputs } from './source-control-primary-action'
import type { GitConflictOperation } from '../../../../shared/types'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import { translate } from '@/i18n/i18n'

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

function formatRebaseBaseRef(baseRef: string): string {
  return baseRef.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
}

function reviewCopy(
  provider: NonNullable<PrimaryActionInputs['hostedReviewCreation']>['provider'] | undefined
): {
  shortLabel: 'PR' | 'MR'
  reviewLabel: 'pull request' | 'merge request'
  providerName: 'GitHub' | 'GitLab'
  authCommand: 'gh auth login' | 'glab auth login'
} {
  return provider === 'gitlab'
    ? {
        shortLabel: 'MR',
        reviewLabel: 'merge request',
        providerName: 'GitLab',
        authCommand: 'glab auth login'
      }
    : {
        shortLabel: 'PR',
        reviewLabel: 'pull request',
        providerName: 'GitHub',
        authCommand: 'gh auth login'
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
  // button's stable-frame guarantee extends to the dropdown.
  const upstreamLoading = upstreamStatus === undefined
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const publishBlockedByMergedPR = !hasUpstream && prState === 'merged'
  const publishBlockedByPRLoading = !hasUpstream && !!isPRStateLoading
  const publishBlockedByNoBranchCommits = !hasUpstream && branchCommitsAhead === 0
  const publishBlockedByUncommittedChanges = publishBlockedByNoBranchCommits && hasDirtyLocalChanges
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0
  const shouldForcePushWithLease = shouldForcePushWithLeaseForUpstream(upstreamStatus)
  const pushLabelCount =
    shouldForcePushWithLease && branchCommitsAhead !== undefined ? branchCommitsAhead : ahead
  const forcePushTitle = formatForcePushTitle(branchCommitsAhead, upstreamStatus?.upstreamName)
  const createReviewCopy = reviewCopy(hostedReviewCreation?.provider)

  // Why: any in-flight commit or remote operation should lock the whole menu.
  // A running push shouldn't let a second pull/sync click queue up behind it
  // on a stale status snapshot.
  const globalBusy = isCommitting || isRemoteOperationActive || isPullRequestOperationActive

  const commitDisabledReason = (() => {
    if (hasUnresolvedConflicts) {
      return 'Resolve conflicts before committing'
    }
    if (!hasStaged) {
      return 'Stage at least one file to commit'
    }
    if (hasPartiallyStagedChanges) {
      return 'Stage all changes before committing partially staged files'
    }
    if (!hasMessage) {
      return 'Enter a commit message to commit'
    }
    return null
  })()
  const canCommit = !globalBusy && commitDisabledReason === null
  const commitItem: DropdownItem = {
    kind: 'commit',
    label: translate("auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd", "Commit"),
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
        : !hasUpstream
          ? 'Publish the branch first to push commits'
          : (commitDisabledReason ??
            (shouldForcePushWithLease
              ? 'Commit staged changes and force push with lease'
              : behind > 0
                ? 'Use Commit & Sync to pull remote changes before pushing'
                : 'Commit staged changes and push'))
  const commitPushItem: DropdownItem = {
    kind: 'commit_push',
    label: shouldForcePushWithLease ? 'Commit & Force Push' : 'Commit & Push',
    title: commitPushTitle,
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      (behind > 0 && !shouldForcePushWithLease) ||
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
    if (behind === 0) {
      return 'Nothing to pull — use Commit & Push instead'
    }
    return commitDisabledReason ?? 'Commit, then pull and push'
  })()
  const commitSyncItem: DropdownItem = {
    kind: 'commit_sync',
    label: translate("auto.components.right.sidebar.source.control.dropdown.items.323bb614aa", "Commit & Sync"),
    title: commitSyncTitle,
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      shouldForcePushWithLease ||
      behind === 0 ||
      commitDisabledReason !== null
  }

  const pushItem: DropdownItem = {
    kind: 'push',
    label: formatCountLabel('Push', ahead),
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : !hasUpstream
            ? 'Publish the branch first to push commits'
            : shouldForcePushWithLease
              ? 'Use Force Push — remote only has older copies of local commits'
              : behind > 0 && ahead > 0
                ? 'Sync first to pull remote changes before pushing'
                : ahead === 0
                  ? `Nothing to push${upstreamStatus?.upstreamName ? ` to ${upstreamStatus.upstreamName}` : ''}`
                  : describePushCount(ahead),
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      ahead === 0 ||
      shouldForcePushWithLease ||
      (behind > 0 && !shouldForcePushWithLease)
  }

  const forcePushItem: DropdownItem = {
    kind: 'force_push',
    label: formatCountLabel('Force Push', pushLabelCount),
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : !hasUpstream
            ? 'Publish the branch first to force push commits'
            : ahead === 0
              ? `Nothing to force push${upstreamStatus?.upstreamName ? ` to ${upstreamStatus.upstreamName}` : ''}`
              : shouldForcePushWithLease
                ? forcePushTitle
                : formatManualForcePushTitle(ahead, behind, upstreamStatus?.upstreamName),
    disabled: globalBusy || upstreamLoading || !hasUpstream || ahead === 0
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
          : !hasUpstream
            ? 'Publish the branch first to pull commits'
            : shouldForcePushWithLease
              ? 'Nothing new to pull — remote only has older copies of local commits'
              : behind === 0
                ? 'Nothing to pull'
                : describePullCount(behind),
    disabled:
      globalBusy || upstreamLoading || !hasUpstream || behind === 0 || shouldForcePushWithLease
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
          : !hasUpstream
            ? 'Publish the branch first to fast-forward'
            : shouldForcePushWithLease
              ? 'Nothing new to fast-forward — remote only has older copies of local commits'
              : behind === 0
                ? 'Nothing to fast-forward'
                : ahead > 0
                  ? 'Local commits prevent a fast-forward pull'
                  : describeFastForwardCount(behind),
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
      behind === 0 ||
      ahead > 0 ||
      shouldForcePushWithLease
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
      shouldForcePushWithLease ||
      (ahead === 0 && behind === 0)
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
      if (hasUnresolvedConflicts) {
        return 'Resolve conflicts before rebasing'
      }
      if (hasDirtyLocalChanges) {
        return 'Commit or stash local changes before rebasing'
      }
      return `Rebase current branch with latest commits from ${rebaseBaseLabel}`
    })(),
    disabled:
      globalBusy ||
      !rebaseBaseRef ||
      !hasRemoteBaseRef ||
      hasUnresolvedConflicts ||
      hasDirtyLocalChanges
  }

  const fetchItem: DropdownItem = {
    kind: 'fetch',
    label: translate("auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7", "Fetch"),
    title: upstreamLoading ? 'Checking branch status…' : 'Fetch from remote without merging',
    disabled: globalBusy || upstreamLoading
  }

  const publishItem: DropdownItem = {
    kind: 'publish',
    label:
      publishBlockedByMergedPR || publishBlockedByPRLoading
        ? 'PR Status'
        : publishBlockedByUncommittedChanges
          ? 'Commit Changes First'
          : publishBlockedByNoBranchCommits
            ? 'No Branch Changes'
            : 'Publish Branch',
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : publishBlockedByUncommittedChanges
            ? 'Commit changes before publishing the branch'
            : publishBlockedByNoBranchCommits
              ? 'Nothing to publish'
              : hasUpstream
                ? 'Branch is already published'
                : 'Publish this branch to origin',
    disabled:
      globalBusy ||
      upstreamLoading ||
      hasUpstream ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR ||
      publishBlockedByNoBranchCommits
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
        return `Run ${createReviewCopy.authCommand} in this environment`
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
    label: translate("auto.components.right.sidebar.source.control.dropdown.items.9e779995dd", "Create {{value0}}", { value0: createReviewCopy.shortLabel }),
    title: hostedReviewCreation?.canCreate
      ? `Create a ${createReviewCopy.reviewLabel} for this branch`
      : createBlockedHint,
    hint: hostedReviewCreation?.canCreate ? undefined : createBlockedHint,
    disabled: globalBusy || upstreamLoading || !hostedReviewCreation?.canCreate
  }

  const canPushAndCreate =
    !globalBusy &&
    !upstreamLoading &&
    (hostedReviewCreation?.provider === 'github' || hostedReviewCreation?.provider === 'gitlab') &&
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
          title: translate("auto.components.right.sidebar.source.control.dropdown.items.7aad2c0240", "Hosted review operation in progress…"),
          disabled: true
        }
  )
}
