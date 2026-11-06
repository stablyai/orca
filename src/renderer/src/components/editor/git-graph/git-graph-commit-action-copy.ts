import { translate } from '@/i18n/i18n'
import type { GitCommitActionResult } from '../../../../../shared/git/commands/git-commit-action'

export type GitGraphCommitAction = 'checkout' | 'cherry-pick' | 'revert'
export function gitGraphActionMessage(result: GitCommitActionResult): string | undefined {
  if (result.message === 'Commit or stash your changes, then try again.') {
    return translate('gitGraph.actionDirty', 'Commit or stash your changes, then try again.')
  }
  if (result.message === 'Git did not create a commit. Check the checkout and try again.') {
    return translate(
      'gitGraph.actionFailed',
      'Git did not create a commit. Check the checkout and try again.'
    )
  }
  const operation =
    /^Finish or abort the (merge|rebase|cherry-pick|revert) in progress before trying again\.$/.exec(
      result.message ?? ''
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
  return result.message
}
export function gitGraphActionLabel(action: GitGraphCommitAction): string {
  switch (action) {
    case 'checkout':
      return translate('gitGraph.checkoutCommit', 'Check out commit')
    case 'cherry-pick':
      return translate('gitGraph.cherryPick', 'Cherry-pick')
    case 'revert':
      return translate('gitGraph.revert', 'Revert')
  }
}
export function gitGraphActionOutcome(result: GitCommitActionResult): string {
  switch (result.outcome) {
    case 'landed':
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
      return translate('gitGraph.alreadyApplied', 'Already applied, nothing to cherry-pick')
    case 'refused':
      return translate('gitGraph.actionRefused', 'The action did not complete.')
  }
}
