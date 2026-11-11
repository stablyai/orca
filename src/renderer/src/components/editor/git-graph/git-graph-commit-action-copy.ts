import { translate } from '@/i18n/i18n'
import { displayIpcErrorMessage } from '@/runtime/errors/ipc-error'
import type { Translate } from '@/i18n/use-translate'
import type { GitCommitActionResult } from '../../../../../shared/git/commands/git-commit-action'

export type GitGraphCommitAction =
  | 'checkout'
  | 'checkout-branch'
  | 'create-branch'
  | 'cherry-pick'
  | 'revert'
export function gitGraphActionMessage(result: GitCommitActionResult): string | undefined {
  const message = result.message && displayIpcErrorMessage(result.message)
  if (
    message ===
    "Orca couldn't create the branch. Check this repository in a terminal, then try again."
  ) {
    return translate(
      'gitGraph.createBranchFailed',
      "Orca couldn't create the branch. Check this repository in a terminal, then try again."
    )
  }
  if (message === 'Commit or stash your changes, then try again.') {
    return translate('gitGraph.actionDirty', 'Commit or stash your changes, then try again.')
  }
  if (message === 'Git did not create a commit. Check the checkout and try again.') {
    return translate(
      'gitGraph.actionFailed',
      'Git did not create a commit. Check the checkout and try again.'
    )
  }
  const operation =
    /^Finish or abort the (merge|rebase|cherry-pick|revert) in progress before trying again\.$/.exec(
      message ?? ''
    )?.[1]
  if (operation) {
    const label =
      operation === 'merge'
        ? translate('auto.components.right.sidebar.checks.panel.content.operation.merge', 'Merge')
        : operation === 'rebase'
          ? translate(
              'auto.components.right.sidebar.checks.panel.content.operation.rebase',
              'Rebase'
            )
          : gitGraphActionLabel(operation === 'revert' ? 'revert' : 'cherry-pick')
    return translate(
      'gitGraph.operationInProgress',
      'Finish or abort the {{operation}} in progress before trying again.',
      { operation: label }
    )
  }
  return message
}
export function gitGraphActionLabel(
  action: GitGraphCommitAction,
  t: Translate = translate
): string {
  switch (action) {
    case 'checkout-branch':
      return t('gitGraph.checkoutBranch', 'Check out branch')
    case 'create-branch':
      return t('gitGraph.createBranch', 'Create branch here')
    case 'checkout':
      return t('gitGraph.checkoutCommit', 'Check out commit')
    case 'cherry-pick':
      return t('gitGraph.cherryPick', 'Cherry-pick')
    case 'revert':
      return t('gitGraph.revert', 'Revert')
  }
}
export function gitGraphActionOutcome(
  result: GitCommitActionResult,
  action?: GitGraphCommitAction
): string {
  switch (result.outcome) {
    case 'landed':
      if (action === 'create-branch') {
        return translate('gitGraph.branchCreated', 'Created {{branch}} at {{commit}}', {
          branch: result.branch,
          commit: result.commitId?.slice(0, 7)
        })
      }
      return translate('gitGraph.actionLanded', 'Now at {{commit}} on {{branch}}', {
        commit: result.commitId?.slice(0, 7),
        branch: result.branch || translate('gitGraph.detachedHead', 'detached HEAD')
      })
    case 'landed-with-warning':
      return translate(
        'gitGraph.actionWarning',
        'The action completed, but Git reported a problem.'
      )
    case 'conflicted':
      return translate(
        'gitGraph.actionConflicted',
        'Resolve the conflicts in Source Control, then continue or abort the operation.'
      )
    case 'empty':
      if (action === 'revert') {
        return translate(
          'gitGraph.nothingToRevert',
          'Nothing to revert; the changes are already undone.'
        )
      }
      return translate('gitGraph.alreadyApplied', 'Already applied, nothing to cherry-pick')
    case 'refused':
      return translate('gitGraph.actionRefused', 'The action did not complete.')
  }
}
