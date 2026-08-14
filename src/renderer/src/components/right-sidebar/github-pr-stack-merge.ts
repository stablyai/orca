import type {
  GitHubPRStack,
  GitHubPRStackEntry
} from '../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

export type GitHubPRStackMergeScope = {
  count: number
  complete: boolean
  entries: GitHubPRStackEntry[]
  label: string
}

export function isGitHubPRStackMergeQueueRequired(
  reviewMergeQueueRequired: boolean | null | undefined,
  stackMergeQueueRequired: boolean | null | undefined
): boolean {
  return reviewMergeQueueRequired === true || stackMergeQueueRequired === true
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
            'auto.components.right.sidebar.github.pr.stack.merge.55ae29b907',
            'Merge through #{{pr}} · {{count}} PR',
            { pr: currentPRNumber, count }
          )
        : translate(
            'auto.components.right.sidebar.github.pr.stack.merge.b8446f6ec2',
            'Merge through #{{pr}} · {{count}} PRs',
            { pr: currentPRNumber, count }
          )
  }
}

export function getGitHubPRStackMergeBlocker(scope: GitHubPRStackMergeScope): string | null {
  for (const entry of scope.entries) {
    if (entry.state === 'draft') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.189d0ec614',
        '#{{pr}} is still a draft.',
        { pr: entry.number }
      )
    }
    if (entry.state === 'closed') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.640fb50d9c',
        '#{{pr}} is closed.',
        { pr: entry.number }
      )
    }
    if (entry.mergeable === 'CONFLICTING' || entry.mergeStateStatus === 'DIRTY') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.46ffcbda75',
        '#{{pr}} has merge conflicts.',
        { pr: entry.number }
      )
    }
    if (entry.reviewDecision === 'CHANGES_REQUESTED') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.6dabefd63e',
        '#{{pr}} has requested changes.',
        { pr: entry.number }
      )
    }
    if (entry.reviewDecision === 'REVIEW_REQUIRED') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.2bb21fc326',
        '#{{pr}} still needs review approval.',
        { pr: entry.number }
      )
    }
    if (entry.mergeStateStatus === 'BEHIND') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.c23faf74df',
        '#{{pr}} must be updated.',
        { pr: entry.number }
      )
    }
    if (entry.mergeStateStatus === 'BLOCKED') {
      return translate(
        'auto.components.right.sidebar.github.pr.stack.merge.f561e80968',
        '#{{pr}} is blocked.',
        { pr: entry.number }
      )
    }
  }
  return null
}
