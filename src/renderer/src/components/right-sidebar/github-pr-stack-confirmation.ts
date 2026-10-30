import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  GitHubPRMergeMethod,
  GitHubPRStack
} from '../../../../shared/github/pull-request-types'
import { getGitHubPRStackMergeScope } from './github-pr-stack-merge'

export function buildGitHubPRStackMergeConfirmation({
  stack,
  currentPRNumber,
  method,
  usesMergeQueue
}: {
  stack: GitHubPRStack
  currentPRNumber: number
  method: GitHubPRMergeMethod
  usesMergeQueue: boolean
}): ConfirmationDialogOptions {
  const scope = getGitHubPRStackMergeScope(stack, currentPRNumber)
  const numbers = scope.entries.map((entry) => `#${entry.number}`).join(', ')
  const included =
    scope.complete && numbers
      ? translate(
          'auto.components.right.sidebar.github.pr.stack.confirmation.84f6f5b9eb',
          'Included: {{numbers}}. ',
          { numbers }
        )
      : ''

  if (usesMergeQueue) {
    return {
      title: translate(
        'auto.components.right.sidebar.github.pr.stack.confirmation.541984b2eb',
        'Queue through #{{pr}}?',
        { pr: currentPRNumber }
      ),
      description: translate(
        'auto.components.right.sidebar.github.pr.stack.confirmation.queueDescription',
        '{{included}}GitHub will add {{count}} pull requests to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
        {
          included,
          count: scope.count,
          defaultValue_one:
            '{{included}}GitHub will add {{count}} pull request to the merge queue together. The queue chooses the merge method and may merge them in separate groups.'
        }
      ),
      confirmLabel: translate(
        'auto.components.right.sidebar.github.pr.stack.confirmation.queueConfirm',
        'Queue {{count}} PRs',
        { count: scope.count, defaultValue_one: 'Queue {{count}} PR' }
      )
    }
  }

  return {
    title: translate(
      'auto.components.right.sidebar.github.pr.stack.confirmation.1feef35ca4',
      'Merge through #{{pr}}?',
      { pr: currentPRNumber }
    ),
    description: translate(
      'auto.components.right.sidebar.github.pr.stack.confirmation.mergeDescription',
      '{{included}}GitHub will merge {{count}} pull requests atomically using {{method}}. If any cannot merge, none will.',
      {
        included,
        count: scope.count,
        method,
        defaultValue_one:
          '{{included}}GitHub will merge {{count}} pull request atomically using {{method}}. If it cannot merge, nothing will be merged.'
      }
    ),
    confirmLabel: translate(
      'auto.components.right.sidebar.github.pr.stack.confirmation.mergeConfirm',
      'Merge {{count}} PRs',
      { count: scope.count, defaultValue_one: 'Merge {{count}} PR' }
    )
  }
}
