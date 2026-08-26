import type { GitHubPRMergeStatePresentation } from '@/components/github-pr-merge-state'
import { getGitHubPRStackMergeBlocker, type GitHubPRStackMergeScope } from './github-pr-stack-merge'
import { translate } from '@/i18n/i18n'

type StackMergeOverrideOptions = {
  /** True when the PR is already sitting in a merge queue. */
  isQueued: boolean
  stackMergeScope: GitHubPRStackMergeScope | null
  hasStack: boolean
  stackMergeLabel?: string
  stackUsesMergeQueue: boolean
}

/**
 * Layers stack-wide merge copy over a single-PR merge presentation.
 *
 * Why the queued guard comes first: the override below forces
 * `directMergeAvailable` on whenever the stack uses a merge queue, which for an
 * already-queued PR would re-offer enqueue. Re-running merge on a queued PR
 * exits 0 without doing anything, so the button would report success and change
 * nothing — the exact failure the queued state exists to prevent.
 */
export function composeStackMergePresentation(
  presentation: GitHubPRMergeStatePresentation,
  {
    isQueued,
    stackMergeScope,
    hasStack,
    stackMergeLabel,
    stackUsesMergeQueue
  }: StackMergeOverrideOptions
): GitHubPRMergeStatePresentation {
  if (isQueued || !hasStack || !stackMergeScope) {
    return presentation
  }
  const stackBlocker = getGitHubPRStackMergeBlocker(stackMergeScope)
  return {
    ...presentation,
    label: stackMergeLabel ?? stackMergeScope.label,
    tooltip:
      stackBlocker ??
      (stackUsesMergeQueue
        ? translate(
            'auto.components.right.sidebar.HostedReviewActions.3de88351c5',
            'GitHub will add this pull request and every pull request below it to the merge queue.'
          )
        : translate(
            'auto.components.right.sidebar.HostedReviewActions.a32fe6dba6',
            'GitHub will merge this pull request and every pull request below it in the stack.'
          )),
    directMergeAvailable:
      !stackBlocker &&
      (stackMergeScope.complete || presentation.directMergeAvailable || stackUsesMergeQueue),
    autoMergeAction: null
  }
}
