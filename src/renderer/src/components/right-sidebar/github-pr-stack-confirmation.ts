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
          'auto.components.right.sidebar.useHostedReviewActions.stackIncluded',
          'Included: {{numbers}}. ',
          { numbers }
        )
      : ''

  if (usesMergeQueue) {
    return {
      title: translate(
        'auto.components.right.sidebar.useHostedReviewActions.queueThroughTitle',
        'Queue through #{{pr}}?',
        { pr: currentPRNumber }
      ),
      description:
        scope.count === 1
          ? translate(
              'auto.components.right.sidebar.useHostedReviewActions.queueDescriptionOne',
              '{{included}}GitHub will add {{count}} pull request to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
              { included, count: scope.count }
            )
          : translate(
              'auto.components.right.sidebar.useHostedReviewActions.queueDescriptionOther',
              '{{included}}GitHub will add {{count}} pull requests to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
              { included, count: scope.count }
            ),
      confirmLabel:
        scope.count === 1
          ? translate(
              'auto.components.right.sidebar.useHostedReviewActions.queueLabelOne',
              'Queue {{count}} PR',
              { count: scope.count }
            )
          : translate(
              'auto.components.right.sidebar.useHostedReviewActions.queueLabelOther',
              'Queue {{count}} PRs',
              { count: scope.count }
            )
    }
  }

  return {
    title: translate(
      'auto.components.right.sidebar.useHostedReviewActions.mergeThroughTitle',
      'Merge through #{{pr}}?',
      { pr: currentPRNumber }
    ),
    description:
      scope.count === 1
        ? translate(
            'auto.components.right.sidebar.useHostedReviewActions.mergeDescriptionOne',
            '{{included}}GitHub will merge {{count}} pull request atomically using {{method}}. If it cannot merge, nothing will be merged.',
            { included, count: scope.count, method }
          )
        : translate(
            'auto.components.right.sidebar.useHostedReviewActions.mergeDescriptionOther',
            '{{included}}GitHub will merge {{count}} pull requests atomically using {{method}}. If any cannot merge, none will.',
            { included, count: scope.count, method }
          ),
    confirmLabel:
      scope.count === 1
        ? translate(
            'auto.components.right.sidebar.useHostedReviewActions.mergeLabelOne',
            'Merge {{count}} PR',
            { count: scope.count }
          )
        : translate(
            'auto.components.right.sidebar.useHostedReviewActions.mergeLabelOther',
            'Merge {{count}} PRs',
            { count: scope.count }
          )
  }
}
