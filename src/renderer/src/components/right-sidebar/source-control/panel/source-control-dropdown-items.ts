// Primary and dropdown actions have independent priority ladders.

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  COMMIT_MESSAGE_REQUIRED_REASON,
  type CommitDisabledReason
} from '../../../../../../shared/source-control/decisions/source-control-commit-eligibility'
import type {
  DropdownActionInputs,
  DropdownActionKind,
  DropdownEntry,
  DropdownItem
} from '../../../../../../shared/source-control/dropdown/source-control-dropdown-item-types'
import { deriveDropdownActionContext } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-action-context'
import {
  buildCommitDropdownItems,
  type CommitDropdownCopy
} from '../../../../../../shared/source-control/dropdown/source-control-dropdown-commit-items'
import { buildRemoteDropdownItems } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-remote-items'
import { localizedRemoteCopy } from './source-control-dropdown-remote-localized-copy'
import { buildHostedReviewDropdownItems } from '../review/source-control-dropdown-review-items'

function localizedCommitDisabledReason(reason: CommitDisabledReason): string {
  switch (reason) {
    case 'Resolve conflicts before committing':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.a6457b46a7',
        'Resolve conflicts before committing'
      )
    case 'Stage at least one file to commit':
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.fa3bd4f40c',
        'Stage at least one file to commit'
      )
    case COMMIT_MESSAGE_REQUIRED_REASON:
      return translate(
        'auto.components.right.sidebar.source.control.primary.action.f01f16d77f',
        'Enter a commit message to commit'
      )
  }
}

function localizedCommitDisabledStatus(reason: CommitDisabledReason): string {
  switch (reason) {
    case 'Resolve conflicts before committing':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.statusConflicts',
        'Conflicts'
      )
    case 'Stage at least one file to commit':
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.statusNothingStaged',
        'Nothing staged'
      )
    case COMMIT_MESSAGE_REQUIRED_REASON:
      return translate(
        'auto.components.right.sidebar.source.control.dropdown.items.statusNeedsMessage',
        'Needs message'
      )
  }
}

function localizedCommitCopy(t: Translate = translate): CommitDropdownCopy {
  return {
    commit: t('auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd', 'Commit'),
    commitStagedChanges: t(
      'auto.components.right.sidebar.source.control.primary.action.ab41fb926b',
      'Commit staged changes'
    ),
    commitPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.commitPush',
      'Commit & Push'
    ),
    commitForcePush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.commitForcePush',
      'Commit & Force Push'
    ),
    commitSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.323bb614aa',
      'Commit & Sync'
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
    checkOutBranchToPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    linkedReviewTargetUnavailable: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    publishBranchFirstToPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToPush',
      'Publish the branch first to push commits'
    ),
    commitAndForcePush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndForcePush',
      'Commit staged changes and force push with lease'
    ),
    commitAndTryPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndTryPush',
      'Commit staged changes and try to push'
    ),
    commitAndPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndPush',
      'Commit staged changes and push'
    ),
    checkOutBranchToSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirst',
      'Publish the branch first to sync commits'
    ),
    useCommitAndForcePush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUseForcePush',
      'Use Commit & Force Push — remote only has older copies of local commits'
    ),
    commitThenPullPush: t(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitThenPullPush',
      'Commit, then pull and push'
    ),
    commitDisabledReason: localizedCommitDisabledReason,
    commitDisabledStatus: localizedCommitDisabledStatus,
    statusNotPublished: t(
      'auto.components.right.sidebar.source.control.dropdown.items.statusNotPublished',
      'Not published'
    ),
    statusNoBranch: t(
      'auto.components.right.sidebar.source.control.dropdown.items.statusNoBranch',
      'No branch'
    )
  }
}

function abortConflictItem(
  operation: 'merge' | 'rebase',
  globalBusy: boolean,
  t: Translate
): DropdownItem {
  const isRebase = operation === 'rebase'
  return {
    kind: isRebase ? 'abort_rebase' : 'abort_merge',
    label: isRebase
      ? t('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
      : t('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge'),
    title: isRebase
      ? t(
          'auto.components.right.sidebar.source.control.dropdown.items.titleAbortRebaseInProgress',
          'Abort the rebase in progress'
        )
      : t(
          'auto.components.right.sidebar.source.control.dropdown.items.titleAbortMergeInProgress',
          'Abort the merge in progress'
        ),
    disabled: globalBusy,
    variant: 'destructive'
  }
}

// Map the primary face to its row so the menu never repeats the button.
function primaryDropdownKind(
  primaryKind: DropdownActionInputs['primaryActionKind'],
  shouldForcePushWithLease: boolean
): DropdownActionKind | null {
  switch (primaryKind) {
    case 'push':
      return shouldForcePushWithLease ? 'force_push' : 'push'
    case 'create_pr_intent':
      return 'push_create_pr'
    case 'commit':
    case 'pull':
    case 'sync':
    case 'publish':
    case 'create_pr':
      return primaryKind
    // Stage All has no menu row; no primary means nothing to hide.
    case 'stage':
    case undefined:
      return null
  }
}

// Force Push and Fetch are deliberate escape hatches, so an idle state does not hide them.
const ALWAYS_LISTED_WHEN_ENABLED = new Set<DropdownActionKind>(['force_push', 'fetch'])

// After an Orca rebase: pulling merges the old copies back and a plain push is rejected.
const HIDDEN_AFTER_ORCA_REBASE = new Set<DropdownActionKind>([
  'pull',
  'sync',
  'fast_forward',
  'push',
  // Commit & Sync pulls after committing, so it would bring the old copies back too.
  'commit_sync'
])

/** List only actions that can run right now, minus the primary; Fetch always stays as the refresh path. */
export function resolveDropdownItems(
  inputs: DropdownActionInputs,
  t: Translate = translate
): DropdownEntry[] {
  const ctx = deriveDropdownActionContext(inputs)
  const { commit, commitPush, commitSync } = buildCommitDropdownItems(ctx, localizedCommitCopy(t))
  const { push, forcePush, pull, fastForward, sync, rebase, fetch, publish } =
    buildRemoteDropdownItems(ctx, localizedRemoteCopy(t))
  const { createPR, pushCreatePR } = buildHostedReviewDropdownItems(ctx, t)
  const { conflictOperation, isPullRequestOperationActive, globalBusy, shouldForcePushWithLease } =
    ctx
  const hiddenPrimaryKind = primaryDropdownKind(inputs.primaryActionKind, shouldForcePushWithLease)
  const lockedFetch: DropdownItem = isPullRequestOperationActive
    ? {
        ...fetch,
        title: t(
          'auto.components.right.sidebar.source.control.dropdown.items.7aad2c0240',
          'Hosted review operation in progress…'
        ),
        disabled: true
      }
    : fetch

  if (conflictOperation === 'rebase') {
    // Push, Sync and Force Push during a paused rebase would publish a half-applied branch.
    // (The commit area, and so this menu, is hidden on main while a rebase is paused.)
    const rebaseEntries: DropdownItem[] = globalBusy
      ? []
      : [abortConflictItem('rebase', globalBusy, t)]
    // Continue only once this stop has been read and Git can continue it.
    if (inputs.rebaseContinueReady && !inputs.hasUnresolvedConflicts && !globalBusy) {
      rebaseEntries.push({
        kind: 'continue_rebase',
        label: t(
          'auto.components.right.sidebar.source.control.dropdown.items.continueRebase',
          'Continue rebase'
        ),
        title: t(
          'auto.components.right.sidebar.source.control.dropdown.items.titleContinueRebase',
          'Continue the paused rebase'
        ),
        disabled: false
      })
    }
    return [...rebaseEntries, { kind: 'separator', id: 'before-fetch' }, lockedFetch]
  }

  // Every action that can run stays reachable: disabled and idle rows, the primary's own row, and
  // (after Orca's rebase over an integrated upstream) Pull/Sync/FF/Push leave the menu.
  const isRunnable = (item: DropdownItem): boolean =>
    !isPullRequestOperationActive &&
    !item.disabled &&
    item.kind !== hiddenPrimaryKind &&
    !(inputs.suppressPullAfterRebase && HIDDEN_AFTER_ORCA_REBASE.has(item.kind)) &&
    // Idle rows (nothing to push, pull or rebase) would run nothing, so they are not listed.
    (!item.idle || ALWAYS_LISTED_WHEN_ENABLED.has(item.kind))
  // Counts and warnings stay; plain notes like "Up to date" only explained a row's state.
  const withoutReasonHint = (item: DropdownItem): DropdownItem =>
    item.statusTone ? item : { ...item, status: undefined, idle: undefined }

  const primaryRows = [
    commit,
    commitPush,
    commitSync,
    rebase,
    push,
    pull,
    sync,
    fastForward,
    publish,
    createPR,
    pushCreatePR
  ]
    .filter(isRunnable)
    .map(withoutReasonHint)
  const trailingRows: DropdownItem[] = [
    ...[forcePush].filter(isRunnable).map(withoutReasonHint),
    lockedFetch
  ]
  if (conflictOperation === 'merge' && !globalBusy) {
    trailingRows.push(abortConflictItem('merge', globalBusy, t))
  }
  return primaryRows.length > 0
    ? [...primaryRows, { kind: 'separator', id: 'before-fallbacks' }, ...trailingRows]
    : trailingRows
}
