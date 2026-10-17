import { translate } from '@/i18n/i18n'
import type { GitHubPRMergeStatePresentation } from './github-pr-merge-state'

export function githubAutoMergeSuccessToast(
  enabled: boolean,
  result: { enqueued?: boolean } | void | null
): string {
  if (!enabled) {
    return translate('auto.components.PullRequestPage.0f5821b035', 'Auto-merge disabled')
  }
  if (result && result.enqueued === true) {
    return translate(
      'auto.components.PullRequestPage.mergeQueueEnqueued',
      'Added to the merge queue'
    )
  }
  return translate('auto.components.PullRequestPage.5edbe7eefa', 'Auto-merge enabled')
}

export function presentPullRequestInMergeQueue(tone: string): GitHubPRMergeStatePresentation {
  return {
    label: translate('auto.components.github.pr.merge.state.inMergeQueue', 'In merge queue'),
    tone,
    tooltip: translate(
      'auto.components.github.pr.merge.state.inMergeQueueTooltip',
      'This pull request is already in the GitHub merge queue'
    ),
    directMergeAvailable: false,
    autoMergeAction: null
  }
}
