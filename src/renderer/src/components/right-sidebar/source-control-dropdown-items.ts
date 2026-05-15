// Why: split from source-control-primary-action because the primary and dropdown are independent derivations with different priority ladders; together they exceed the max-lines budget and tangle unrelated concerns.

import type { PrimaryActionInputs } from './source-control-primary-action'

export type DropdownActionKind =
  | 'commit'
  | 'commit_push'
  | 'commit_sync'
  | 'create_pr'
  | 'push_create_pr'
  | 'push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'publish'

export type DropdownItem = {
  kind: DropdownActionKind
  label: string
  title: string
  disabled: boolean
  hint?: string
}

export type DropdownSeparator = { kind: 'separator' }

export type DropdownEntry = DropdownItem | DropdownSeparator

function describePushCount(ahead: number): string {
  return `Push ${ahead} commit${ahead === 1 ? '' : 's'}`
}

function describePullCount(behind: number): string {
  return `Pull ${behind} commit${behind === 1 ? '' : 's'}`
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

/**
 * Resolve the chevron dropdown items. Every item is always rendered so the
 * menu shape stays stable across states; inapplicable rows are disabled
 * with a tooltip reason rather than hidden.
 */
export function resolveDropdownItems(inputs: PrimaryActionInputs): DropdownEntry[] {
  const {
    stagedCount,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    prState,
    isPRStateLoading,
    hostedReviewCreation
  } = inputs

  const hasStaged = stagedCount > 0
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
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0

  // Why: any in-flight commit or remote operation should lock the whole menu.
  // A running push shouldn't let a second pull/sync click queue up behind it
  // on a stale status snapshot.
  const globalBusy = isCommitting || isRemoteOperationActive

  const commitDisabledReason = (() => {
    if (hasUnresolvedConflicts) {
      return 'Resolve conflicts before committing'
    }
    if (!hasStaged) {
      return 'Stage at least one file to commit'
    }
    if (!hasMessage) {
      return 'Enter a commit message to commit'
    }
    return null
  })()
  const canCommit = !globalBusy && commitDisabledReason === null
  const commitItem: DropdownItem = {
    kind: 'commit',
    label: 'Commit',
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
          : (commitDisabledReason ?? 'Commit staged changes and push')
  const commitPushItem: DropdownItem = {
    kind: 'commit_push',
    label: 'Commit & Push',
    title: commitPushTitle,
    disabled:
      globalBusy ||
      upstreamLoading ||
      !hasUpstream ||
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
    if (behind === 0) {
      return 'Nothing to pull — use Commit & Push instead'
    }
    return commitDisabledReason ?? 'Commit, then pull and push'
  })()
  const commitSyncItem: DropdownItem = {
    kind: 'commit_sync',
    label: 'Commit & Sync',
    title: commitSyncTitle,
    disabled:
      globalBusy || upstreamLoading || !hasUpstream || behind === 0 || commitDisabledReason !== null
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
            : ahead === 0
              ? 'Nothing to push'
              : describePushCount(ahead),
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
            : behind === 0
              ? 'Nothing to pull'
              : describePullCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || behind === 0
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
            : ahead === 0 && behind === 0
              ? 'Branch is up to date'
              : describeSyncCounts(ahead, behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || (ahead === 0 && behind === 0)
  }

  const fetchItem: DropdownItem = {
    kind: 'fetch',
    label: 'Fetch',
    title: upstreamLoading ? 'Checking branch status…' : 'Fetch from remote without merging',
    disabled: globalBusy || upstreamLoading
  }

  const publishItem: DropdownItem = {
    kind: 'publish',
    label: publishBlockedByMergedPR || publishBlockedByPRLoading ? 'PR Status' : 'Publish Branch',
    title: upstreamLoading
      ? 'Checking branch status…'
      : publishBlockedByPRLoading
        ? 'Checking PR status…'
        : publishBlockedByMergedPR
          ? 'PR is already merged'
          : hasUpstream
            ? 'Branch is already published'
            : 'Publish this branch to origin',
    disabled:
      globalBusy ||
      upstreamLoading ||
      hasUpstream ||
      publishBlockedByPRLoading ||
      publishBlockedByMergedPR
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
        return 'Sync first'
      case 'auth_required':
        return 'Run gh auth login in this environment'
      case 'unsupported_provider':
        return 'Unsupported provider'
      case 'existing_review':
        return 'A pull request already exists'
      case 'fork_head_unsupported':
        return 'Fork head unsupported'
      default:
        return upstreamLoading ? 'Checking branch status…' : 'Branch is not ready'
    }
  })()

  const createPRItem: DropdownItem = {
    kind: 'create_pr',
    label: 'Create PR',
    title: hostedReviewCreation?.canCreate
      ? 'Create a pull request for this branch'
      : createBlockedHint,
    hint: hostedReviewCreation?.canCreate ? undefined : createBlockedHint,
    disabled: globalBusy || upstreamLoading || !hostedReviewCreation?.canCreate
  }

  const canPushAndCreate =
    !globalBusy &&
    !upstreamLoading &&
    hostedReviewCreation?.provider === 'github' &&
    hostedReviewCreation.blockedReason === 'needs_push'
  const pushCreatePRItem: DropdownItem = {
    kind: 'push_create_pr',
    label: 'Push & Create PR',
    title: canPushAndCreate ? 'Push local commits, then create a pull request' : createBlockedHint,
    hint: canPushAndCreate ? undefined : createBlockedHint,
    disabled: !canPushAndCreate
  }

  return [
    commitItem,
    commitPushItem,
    commitSyncItem,
    { kind: 'separator' },
    pushItem,
    createPRItem,
    pushCreatePRItem,
    pullItem,
    syncItem,
    fetchItem,
    publishItem
  ]
}
