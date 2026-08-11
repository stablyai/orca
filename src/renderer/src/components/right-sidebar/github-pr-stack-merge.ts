import type { GitHubPRStack, GitHubPRStackEntry } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type GitHubPRStackMergeScope = {
  count: number
  complete: boolean
  entries: GitHubPRStackEntry[]
  label: string
}

export function getGitHubPRStackMergeScope(
  stack: GitHubPRStack,
  currentPRNumber: number
): GitHubPRStackMergeScope {
  const entries = [...(stack.entries ?? [])]
    .filter((entry) => entry.position <= stack.position)
    .sort((a, b) => a.position - b.position)
  const count = stack.position
  const complete =
    entries.length === count && entries.every((entry, index) => entry.position === index + 1)
  return {
    count,
    complete,
    entries,
    label:
      count === 1
        ? translate(
            'auto.components.right.sidebar.githubPRStackMerge.labelOne',
            'Merge through #{{pr}} · {{count}} PR',
            { pr: currentPRNumber, count }
          )
        : translate(
            'auto.components.right.sidebar.githubPRStackMerge.labelOther',
            'Merge through #{{pr}} · {{count}} PRs',
            { pr: currentPRNumber, count }
          )
  }
}

export function getGitHubPRStackMergeBlocker(scope: GitHubPRStackMergeScope): string | null {
  for (const entry of scope.entries) {
    if (entry.state === 'draft') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerDraft',
        '#{{pr}} is still a draft.',
        { pr: entry.number }
      )
    }
    if (entry.state === 'closed') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerClosed',
        '#{{pr}} is closed.',
        { pr: entry.number }
      )
    }
    if (entry.mergeable === 'CONFLICTING' || entry.mergeStateStatus === 'DIRTY') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerConflicts',
        '#{{pr}} has merge conflicts.',
        { pr: entry.number }
      )
    }
    if (entry.reviewDecision === 'CHANGES_REQUESTED') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerChanges',
        '#{{pr}} has requested changes.',
        { pr: entry.number }
      )
    }
    if (entry.reviewDecision === 'REVIEW_REQUIRED') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerReview',
        '#{{pr}} still needs review approval.',
        { pr: entry.number }
      )
    }
    if (entry.mergeStateStatus === 'BEHIND') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerBehind',
        '#{{pr}} must be updated.',
        { pr: entry.number }
      )
    }
    if (entry.mergeStateStatus === 'BLOCKED') {
      return translate(
        'auto.components.right.sidebar.githubPRStackMerge.blockerBlocked',
        '#{{pr}} is blocked.',
        { pr: entry.number }
      )
    }
  }
  return null
}
