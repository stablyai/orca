import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { GitHubPRMergeMethod, GitHubPRStack } from '../../../../shared/types'
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
      description:
        scope.count === 1
          ? translate(
              'auto.components.right.sidebar.github.pr.stack.confirmation.4809f55cdb',
              '{{included}}GitHub will add {{count}} pull request to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
              { included, count: scope.count }
            )
          : translate(
              'auto.components.right.sidebar.github.pr.stack.confirmation.be8f2621be',
              '{{included}}GitHub will add {{count}} pull requests to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
              { included, count: scope.count }
            ),
      confirmLabel:
        scope.count === 1
          ? translate(
              'auto.components.right.sidebar.github.pr.stack.confirmation.92ca033e72',
              'Queue {{count}} PR',
              { count: scope.count }
            )
          : translate(
              'auto.components.right.sidebar.github.pr.stack.confirmation.478a527b15',
              'Queue {{count}} PRs',
              { count: scope.count }
            )
    }
  }

  return {
    title: translate(
      'auto.components.right.sidebar.github.pr.stack.confirmation.1feef35ca4',
      'Merge through #{{pr}}?',
      { pr: currentPRNumber }
    ),
    description:
      scope.count === 1
        ? translate(
            'auto.components.right.sidebar.github.pr.stack.confirmation.c3e036c99f',
            '{{included}}GitHub will merge {{count}} pull request atomically using {{method}}. If it cannot merge, nothing will be merged.',
            { included, count: scope.count, method }
          )
        : translate(
            'auto.components.right.sidebar.github.pr.stack.confirmation.369aba4b32',
            '{{included}}GitHub will merge {{count}} pull requests atomically using {{method}}. If any cannot merge, none will.',
            { included, count: scope.count, method }
          ),
    confirmLabel:
      scope.count === 1
        ? translate(
            'auto.components.right.sidebar.github.pr.stack.confirmation.493c78f521',
            'Merge {{count}} PR',
            { count: scope.count }
          )
        : translate(
            'auto.components.right.sidebar.github.pr.stack.confirmation.eb7051d268',
            'Merge {{count}} PRs',
            { count: scope.count }
          )
  }
}
