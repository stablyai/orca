// Primary and dropdown actions have independent priority ladders.

import { translate } from '@/i18n/i18n'
import type {
  DropdownActionInputs,
  DropdownEntry
} from '../../../../shared/source-control-dropdown-item-types'
import { deriveDropdownActionContext } from '../../../../shared/source-control-dropdown-action-context'
import {
  buildCommitDropdownItems,
  type CommitDropdownCopy
} from '../../../../shared/source-control-dropdown-commit-items'
import {
  buildRemoteDropdownItems,
  type RemoteDropdownCopy
} from '../../../../shared/source-control-dropdown-remote-items'
import { buildHostedReviewDropdownItems } from './source-control-dropdown-review-items'

function localizedCommitCopy(): CommitDropdownCopy {
  return {
    commit: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.2b8e6595fd',
      'Commit'
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
    )
  }
}

function localizedRemoteCopy(): RemoteDropdownCopy {
  return {
    rebaseFromNamedBase: (baseRef) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromNamedBase',
        'Rebase from {{baseRef}}',
        { baseRef }
      ),
    rebaseFromBase: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseFromBase',
      'Rebase from Base'
    ),
    rebaseChooseRemoteBase: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseChooseRemoteBase',
      'Choose a remote base branch to rebase from'
    ),
    rebaseDirtyHint: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.rebaseDirtyHint',
      'Try rebasing; git may require committing or stashing local changes first'
    ),
    rebaseWithLatestFrom: (baseRef) =>
      translate(
        'auto.components.right.sidebar.source.control.dropdown.items.rebaseWithLatestFrom',
        'Rebase current branch with latest commits from {{baseRef}}',
        { baseRef }
      ),
    fetch: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7',
      'Fetch'
    ),
    fetchTitle: translate(
      'auto.components.right.sidebar.source.control.dropdown.items.04d709801d',
      'Fetch from remote without merging'
    )
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
    const label = isRebase ? 'Abort rebase' : 'Abort merge'
    entries.push(
      { kind: 'separator', id: 'before-abort' },
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
