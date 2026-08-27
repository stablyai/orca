import { canEnableGitHubPRAutoMerge } from '../../../shared/github/pull-request-auto-merge-availability'
import { translate } from '@/i18n/i18n'
import type { GitHubPRMergeStateInput } from './github-pr-merge-state'

export type GitHubPRAutoMergeAction = {
  kind: 'enable' | 'disable'
  label: string
  tooltip: string
}

// Why: GitHub rejects enabling auto-merge on a conflicting PR, so offering it
// there only yields an error toast. Repos can also disable auto-merge entirely,
// so suppress the action when GitHub explicitly reports that setting is off.
function canEnableAutoMerge(item: GitHubPRMergeStateInput): boolean {
  return canEnableGitHubPRAutoMerge(item)
}

/**
 * The auto-merge toggle offered alongside a PR's merge state. Keeps the original
 * `auto.components.github.pr.merge.state.*` message ids so catalogs stay stable.
 */
export function resolveGitHubPRAutoMergeAction(
  item: GitHubPRMergeStateInput
): GitHubPRAutoMergeAction | null {
  // Why: only a plain open PR can take an auto-merge request — a queued PR is
  // already in the queue, and merged/closed/draft have nothing to schedule.
  if (item.state !== 'open') {
    return null
  }
  if (item.autoMergeEnabled === true) {
    return {
      kind: 'disable',
      label: translate('auto.components.github.pr.merge.state.48d75ae118', 'Disable auto-merge'),
      tooltip: translate(
        'auto.components.github.pr.merge.state.62703b1dc4',
        'GitHub auto-merge is enabled for this pull request'
      )
    }
  }
  if (item.mergeQueueRequired === true) {
    return {
      kind: 'enable',
      label: translate('auto.components.github.pr.merge.state.b169f943e1', 'Merge when ready'),
      tooltip: translate(
        'auto.components.github.pr.merge.state.331ebe1170',
        'Add this pull request to the GitHub merge queue'
      )
    }
  }
  if (canEnableAutoMerge(item)) {
    return {
      kind: 'enable',
      label: translate('auto.components.github.pr.merge.state.4ab19a62ef', 'Enable auto-merge'),
      tooltip: translate(
        'auto.components.github.pr.merge.state.8f6cb3772f',
        'Merge this pull request automatically once requirements are met'
      )
    }
  }
  return null
}
