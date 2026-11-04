import type { GitHubPRMergeMethod } from '../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

export function getPullRequestStateConfirmationTitle(
  nextState: 'open' | 'closed',
  number: number
): string {
  return nextState === 'closed'
    ? translate('auto.components.PullRequestConfirmation.closeTitle', 'Close PR #{{number}}?', {
        number
      })
    : translate('auto.components.PullRequestConfirmation.reopenTitle', 'Reopen PR #{{number}}?', {
        number
      })
}

export function getPullRequestMergeConfirmationTitle(
  method: GitHubPRMergeMethod,
  number: number
): string {
  switch (method) {
    case 'merge':
      return translate(
        'auto.components.PullRequestConfirmation.mergeTitle',
        'Merge PR #{{number}} with a merge commit?',
        { number }
      )
    case 'squash':
      return translate(
        'auto.components.PullRequestConfirmation.squashTitle',
        'Squash and merge PR #{{number}}?',
        { number }
      )
    case 'rebase':
      return translate(
        'auto.components.PullRequestConfirmation.rebaseTitle',
        'Rebase and merge PR #{{number}}?',
        { number }
      )
  }
}

export function getPullRequestMergeMethodLabel(method: GitHubPRMergeMethod): string {
  switch (method) {
    case 'merge':
      return translate('auto.components.PullRequestConfirmation.mergeLabel', 'Create merge commit')
    case 'squash':
      return translate('auto.components.PullRequestConfirmation.squashLabel', 'Squash and merge')
    case 'rebase':
      return translate('auto.components.PullRequestConfirmation.rebaseLabel', 'Rebase and merge')
  }
}
