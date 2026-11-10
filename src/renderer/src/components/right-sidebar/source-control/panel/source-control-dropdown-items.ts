// Primary and dropdown actions have independent priority ladders.

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  COMMIT_MESSAGE_REQUIRED_REASON,
  type CommitDisabledReason
} from '../../../../../../shared/source-control/decisions/source-control-commit-eligibility'
import type {
  DropdownActionInputs,
  DropdownEntry
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
    commitDisabledReason: localizedCommitDisabledReason
  }
}

/** Keep menu shape stable across states: render every row with its disabled reason. */
export function resolveDropdownItems(
  inputs: DropdownActionInputs,
  t: Translate = translate
): DropdownEntry[] {
  const ctx = deriveDropdownActionContext(inputs)
  const { commit, commitPush, commitSync } = buildCommitDropdownItems(ctx, localizedCommitCopy(t))
  const { push, forcePush, pull, fastForward, sync, rebase, fetch, publish } =
    buildRemoteDropdownItems(ctx, localizedRemoteCopy(t))
  const { createPR, pushCreatePR } = buildHostedReviewDropdownItems(ctx, t)
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
      ? t('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
      : t('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')
    entries.push(
      { kind: 'separator', id: 'before-abort' },
      {
        kind: isRebase ? 'abort_rebase' : 'abort_merge',
        label,
        title: globalBusy
          ? t(
              'auto.components.right.sidebar.source.control.dropdown.items.titleOperationInProgress',
              'Operation in progress…'
            )
          : isRebase
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
          title: t(
            'auto.components.right.sidebar.source.control.dropdown.items.7aad2c0240',
            'Hosted review operation in progress…'
          ),
          disabled: true
        }
  )
}
