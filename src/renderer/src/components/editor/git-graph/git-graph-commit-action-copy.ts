import { translate } from '@/i18n/i18n'
import type { GitCommitActionResult } from '../../../../../shared/git/commands/git-commit-action'

export type GitGraphCommitAction = 'checkout' | 'cherry-pick' | 'revert'
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
