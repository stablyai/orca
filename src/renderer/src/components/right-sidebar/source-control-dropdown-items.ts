// Primary and dropdown actions have independent priority ladders.

import { translate } from '@/i18n/i18n'
import {
  COMMIT_MESSAGE_REQUIRED_REASON,
  type CommitDisabledReason
} from '../../../../shared/source-control-commit-eligibility'
import type {
  DropdownActionInputs,
  DropdownEntry
} from '../../../../shared/source-control-dropdown-item-types'
import { deriveDropdownActionContext } from '../../../../shared/source-control-dropdown-action-context'
import {
  buildCommitDropdownItems,
  type CommitDropdownCopy
} from '../../../../shared/source-control-dropdown-commit-items'
import { buildRemoteDropdownItems } from '../../../../shared/source-control-dropdown-remote-items'
import { localizedRemoteCopy } from './source-control-dropdown-remote-localized-copy'
import { buildHostedReviewDropdownItems } from './source-control-dropdown-review-items'

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

function localizedCommitCopy(): CommitDropdownCopy {
  return {
    commit: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd',
      'Commit'
    ),
    commitStagedChanges: translate(
      'auto.components.right.sidebar.source.control.primary.action.ab41fb926b',
      'Commit staged changes'
    ),
    commitPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.commitPush',
      'Commit & Push'
    ),
    commitForcePush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.commitForcePush',
      'Commit & Force Push'
    ),
    commitSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.323bb614aa',
      'Commit & Sync'
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
    checkOutBranchToPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    linkedReviewTargetUnavailable: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleLinkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    publishBranchFirstToPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirstToPush',
      'Publish the branch first to push commits'
    ),
    commitAndForcePush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndForcePush',
      'Commit staged changes and force push with lease'
    ),
    commitAndTryPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndTryPush',
      'Commit staged changes and try to push'
    ),
    commitAndPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitAndPush',
      'Commit staged changes and push'
    ),
    checkOutBranchToSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCheckOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titlePublishBranchFirst',
      'Publish the branch first to sync commits'
    ),
    useCommitAndForcePush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUseForcePush',
      'Use Commit & Force Push — remote only has older copies of local commits'
    ),
    commitThenPullPush: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleCommitThenPullPush',
      'Commit, then pull and push'
    ),
    commitDisabledReason: localizedCommitDisabledReason
  }
}

/** Keep menu shape stable across states: render every row, disabling blocked actions with tooltip reasons. */
export function resolveDropdownItems(inputs: DropdownActionInputs): DropdownEntry[] {
  const ctx = deriveDropdownActionContext(inputs)
  const { commit, commitPush, commitSync } = buildCommitDropdownItems(ctx, localizedCommitCopy())
  const { push, forcePush, pull, fastForward, sync, rebase, fetch, publish } =
    buildRemoteDropdownItems(ctx, localizedRemoteCopy())
  const { createPR, pushCreatePR } = buildHostedReviewDropdownItems(ctx)
  const { conflictOperation, isPullRequestOperationActive, globalBusy } = ctx

  const entries: DropdownEntry[] = [
    commit,
    commitPush,
    commitSync,
    { kind: 'separator', id: 'before-remote' },
    push,
    forcePush,
    createPR,
    pushCreatePR,
    pull,
    fastForward,
    sync,
    rebase,
    fetch,
    publish
  ]
  if (conflictOperation === 'merge' || conflictOperation === 'rebase') {
    const isRebase = conflictOperation === 'rebase'
    const label = isRebase
      ? translate('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
      : translate('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')
    entries.push(
      { kind: 'separator', id: 'before-abort' },
      {
        kind: isRebase ? 'abort_rebase' : 'abort_merge',
        label,
        title: globalBusy
          ? translate(
              'auto.components.right.sidebar.source.control.dropdown.items.titleOperationInProgress',
              'Operation in progress…'
            )
          : isRebase
            ? translate(
                'auto.components.right.sidebar.source.control.dropdown.items.titleAbortRebaseInProgress',
                'Abort the rebase in progress'
              )
            : translate(
                'auto.components.right.sidebar.source.control.dropdown.items.titleAbortMergeInProgress',
                'Abort the merge in progress'
              ),
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
